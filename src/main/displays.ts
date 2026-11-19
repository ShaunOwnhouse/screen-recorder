import { execFile } from 'node:child_process'
import type { Rect } from '../shared/types.ts'

export interface DxgiOutput {
  adapter: number
  output: number
  name: string
  left: number
  top: number
  right: number
  bottom: number
}

// FFmpeg's ddagrab addresses monitors by (adapter, output) index, which Electron doesn't expose.
// This enumerates DXGI the same way FFmpeg does and reports each output's desktop rectangle so
// it can be matched to an Electron display. Raw vtable calls avoid needing any native module.
const PROBE_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DxgiProbe {
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct OutputDesc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public int Left, Top, Right, Bottom;
    public int AttachedToDesktop;
    public int Rotation;
    public IntPtr Monitor;
  }

  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumFn(IntPtr self, uint index, out IntPtr result);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DescFn(IntPtr self, out OutputDesc desc);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint ReleaseFn(IntPtr self);

  static T Slot<T>(IntPtr obj, int index) where T : class {
    IntPtr fn = Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), index * IntPtr.Size);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
  }

  public static string Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr factory;
    if (CreateDXGIFactory1(ref iid, out factory) < 0) return "[]";
    StringBuilder sb = new StringBuilder("[");
    bool first = true;
    for (uint a = 0; a < 16; a++) {
      IntPtr adapter;
      if (Slot<EnumFn>(factory, 7)(factory, a, out adapter) < 0) break;
      for (uint o = 0; o < 16; o++) {
        IntPtr output;
        if (Slot<EnumFn>(adapter, 7)(adapter, o, out output) < 0) break;
        OutputDesc d;
        if (Slot<DescFn>(output, 7)(output, out d) >= 0 && d.AttachedToDesktop != 0) {
          if (!first) sb.Append(",");
          first = false;
          sb.AppendFormat("{{\"adapter\":{0},\"output\":{1},\"name\":\"{2}\",\"left\":{3},\"top\":{4},\"right\":{5},\"bottom\":{6}}}",
            a, o, d.DeviceName.Replace("\\", "\\\\"), d.Left, d.Top, d.Right, d.Bottom);
        }
        Slot<ReleaseFn>(output, 2)(output);
      }
      Slot<ReleaseFn>(adapter, 2)(adapter);
    }
    Slot<ReleaseFn>(factory, 2)(factory);
    return sb.Append("]").ToString();
  }
}`

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${PROBE_CS}
'@
[DxgiProbe]::Run()`

let cached: Promise<DxgiOutput[]> | null = null

export function invalidateDxgiOutputs(): void {
  cached = null
}

export function dxgiOutputs(): Promise<DxgiOutput[]> {
  if (!cached) cached = probe()
  return cached
}

export function runDxgiProbe(): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    )
  })
}

async function probe(): Promise<DxgiOutput[]> {
  if (process.platform !== 'win32') return []
  const res = await runDxgiProbe()
  return res.ok ? parseDxgiOutputs(res.stdout) : []
}

export function parseDxgiOutputs(stdout: string): DxgiOutput[] {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  try {
    const parsed = JSON.parse(line)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Finds the DXGI output whose desktop rectangle matches a display's physical bounds. */
export function matchOutput(outputs: DxgiOutput[], physicalBounds: Rect): DxgiOutput | null {
  let best: DxgiOutput | null = null
  let bestScore = Infinity
  for (const o of outputs) {
    const score =
      Math.abs(o.left - physicalBounds.x) +
      Math.abs(o.top - physicalBounds.y) +
      Math.abs(o.right - o.left - physicalBounds.width) +
      Math.abs(o.bottom - o.top - physicalBounds.height)
    if (score < bestScore) {
      best = o
      bestScore = score
    }
  }
  return bestScore <= 16 ? best : null
}
