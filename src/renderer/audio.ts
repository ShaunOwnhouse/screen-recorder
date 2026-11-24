import type { AudioConfigPayload } from '../shared/api.ts'

const bridge = window.audioBridge

let ctx: AudioContext | null = null
let streams: MediaStream[] = []
let meterTimer: ReturnType<typeof setInterval> | null = null

function errorText(err: unknown): string {
  const e = err as DOMException
  if (e?.name === 'NotAllowedError') return 'access was blocked — check Windows Settings › Privacy › Microphone'
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'device not found (unplugged?)'
  return e?.message ?? String(err)
}

function peak(analyser: AnalyserNode, buf: Float32Array): number {
  analyser.getFloatTimeDomainData(buf)
  let max = 0
  for (const v of buf) max = Math.max(max, Math.abs(v))
  return Math.min(1, max)
}

async function stop(): Promise<void> {
  if (meterTimer) clearInterval(meterTimer)
  meterTimer = null
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
  streams = []
  if (ctx) await ctx.close().catch(() => undefined)
  ctx = null
}

async function start(cfg: AudioConfigPayload): Promise<{ started: string[]; errors: string[] }> {
  await stop()
  const started: string[] = []
  const errors: string[] = []

  ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
  await ctx.audioWorklet.addModule('./pcm-worklet.js')
  // Each source is captured on its own (computer sound and microphone are never merged here), so the recording keeps
  // them apart and the editor can treat them separately. FFmpeg makes the mix.
  const meters: Record<'system' | 'mic', AnalyserNode | null> = { system: null, mic: null }
  const attach = (stream: MediaStream, volume: number, name: 'system' | 'mic'): void => {
    const capture = new AudioWorkletNode(ctx!, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit'
    })
    capture.port.onmessage = (e: MessageEvent<Float32Array>) => bridge.pcm(name, e.data)
    // The worklet only runs while something pulls on it, so route it to a silent output.
    const silent = new GainNode(ctx!, { gain: 0 })
    capture.connect(silent).connect(ctx!.destination)
    const source = ctx!.createMediaStreamSource(stream)
    const gain = new GainNode(ctx!, { gain: volume })
    const analyser = new AnalyserNode(ctx!, { fftSize: 1024 })
    source.connect(gain)
    gain.connect(capture)
    gain.connect(analyser)
    streams.push(stream)
    meters[name] = analyser
    started.push(name)
  }

  // Open both sources at once, each with its own time limit, so a stuck device can't block the other.
  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for the device')), ms)
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        }
      )
    })

  const openSystem = async (): Promise<void> => {
    // Chromium's desktop source with audio = WASAPI loopback of everything the PC is playing.
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } }
      } as unknown as MediaStreamConstraints),
      8000
    )
    stream.getVideoTracks().forEach((t) => {
      t.stop()
      stream.removeTrack(t)
    })
    attach(stream, cfg.systemVolume, 'system')
  }

  const openMic = async (): Promise<void> => {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: cfg.mic === 'default' ? undefined : { exact: cfg.mic! },
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: cfg.noiseSuppression
        }
      }),
      8000
    )
    attach(stream, cfg.micVolume, 'mic')
  }

  const jobs: { label: string; run: Promise<void> }[] = []
  if (cfg.system) jobs.push({ label: 'Computer sound', run: openSystem() })
  if (cfg.mic) jobs.push({ label: 'Microphone', run: openMic() })
  const settled = await Promise.allSettled(jobs.map((j) => j.run))
  settled.forEach((r, i) => {
    if (r.status === 'rejected') errors.push(`${jobs[i].label}: ${errorText(r.reason)}`)
  })

  const buf = new Float32Array(1024)
  meterTimer = setInterval(() => {
    bridge.levels({
      system: meters.system ? peak(meters.system, buf) : null,
      mic: meters.mic ? peak(meters.mic, buf) : null
    })
  }, 100)

  return { started, errors }
}

async function listDevices(opts: { prime?: boolean } | undefined): Promise<{ id: string; label: string }[]> {
  // Device labels are only exposed after microphone access has been granted once.
  if (opts?.prime !== false) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    } catch {
      // Still list devices; labels may be generic.
    }
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

bridge.onStart((cfg) => start(cfg))
bridge.onStop(() => stop())
bridge.onListDevices((opts) => listDevices(opts))


// ---------- the webcam ----------

let camStream: MediaStream | null = null
let camRecorder: MediaRecorder | null = null
let chunkChain: Promise<void> = Promise.resolve()

function cameraErrorText(err: unknown): string {
  const e = err as DOMException
  if (e?.name === 'NotAllowedError') return 'access was blocked — check Windows Settings › Privacy › Camera (and that “Let desktop apps access your camera” is on)'
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'no camera found (unplugged?)'
  if (e?.name === 'NotReadableError') return 'another app is using the camera'
  return e?.message ?? String(err)
}

async function listCameras(): Promise<{ id: string; label: string }[]> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true })
    s.getTracks().forEach((t) => t.stop())
  } catch {
    // labels may be generic without access
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
}

async function closeCamera(): Promise<void> {
  if (camRecorder && camRecorder.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      camRecorder!.onstop = () => resolve()
      camRecorder!.stop()
    })
  }
  await chunkChain
  camRecorder = null
  camStream?.getTracks().forEach((t) => t.stop())
  camStream = null
}

async function openCamera(p: { device: string; mic: string | null }): Promise<{ ok: boolean; error?: string; width?: number; height?: number; hasAudio?: boolean }> {
  await closeCamera()
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: p.device && p.device !== 'default' ? { exact: p.device } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: p.mic
        ? { deviceId: p.mic === 'default' ? undefined : { exact: p.mic }, echoCancellation: false, autoGainControl: false, noiseSuppression: false }
        : false
    })
  } catch (err) {
    // the camera is wanted more than the microphone alongside it, so try again with the picture alone
    if (p.mic) return openCamera({ device: p.device, mic: null })
    return { ok: false, error: cameraErrorText(err) }
  }
  const v = camStream.getVideoTracks()[0]?.getSettings() ?? {}
  return { ok: true, width: v.width, height: v.height, hasAudio: camStream.getAudioTracks().length > 0 }
}

function startCamera(): Promise<{ startedAt: number }> {
  if (!camStream) throw new Error('the camera is not open')
  const withAudio = camStream.getAudioTracks().length > 0
  const mime = [`video/webm;codecs=vp8${withAudio ? ',opus' : ''}`, `video/webm;codecs=vp9${withAudio ? ',opus' : ''}`, 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
  camRecorder = new MediaRecorder(camStream, { mimeType: mime, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 })
  chunkChain = Promise.resolve()
  camRecorder.ondataavailable = (e) => {
    if (!e.data.size) return
    // keep the pieces in order even though reading each one is asynchronous
    chunkChain = chunkChain.then(async () => bridge.cameraChunk(new Uint8Array(await e.data.arrayBuffer())))
  }
  return new Promise((resolve) => {
    camRecorder!.onstart = () => resolve({ startedAt: Date.now() })
    camRecorder!.start(1000)
  })
}

bridge.onCameraDevices(() => listCameras())
bridge.onCameraOpen((p) => openCamera(p))
bridge.onCameraStart(() => startCamera())
bridge.onCameraPause(async () => {
  if (camRecorder?.state === 'recording') camRecorder.pause()
})
bridge.onCameraResume(async () => {
  if (camRecorder?.state === 'paused') camRecorder.resume()
})
bridge.onCameraStop(() => closeCamera())
