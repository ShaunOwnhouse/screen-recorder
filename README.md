# Screen Recorder

A screen recorder for Windows and macOS that keeps full HD, 1440p and 4K quality all the way to the saved file.

## Why the output stays sharp

Windows' built-in Snipping Tool recorder encodes at a low bitrate, which blurs text and fine detail. This app avoids that in a few ways:

- **Native resolution by default.** Every physical pixel on your screen is captured, including on scaled (125% / 150%) displays. Nothing is resized unless you choose an output size.
- **Constant-quality encoding.** It uses a quality target (CRF/CQ) rather than a bitrate cap, so busy scenes get the bits they need.
- **GPU encoding.** It detects NVIDIA (NVENC), Intel (Quick Sync) and AMD (AMF) encoders and uses the best one, so 4K60 runs in real time. NVENC uses adaptive quantisation, which puts bits into text and edges. If no GPU encoder is available it falls back to x264 on the CPU.
- **Fast capture on every monitor.** Each screen is matched to its own graphics adapter and output, so Desktop Duplication (`ddagrab`) works on any monitor, including mixed-scaling setups and laptops with two GPUs. GDI is only a fallback.
- **Optional 4:4:4 colour.** The *Maximum* preset keeps full chroma resolution, so coloured text and thin lines stay crisp.
- **Correct colour.** Video is converted and tagged as BT.709, so colours match your screen in every player.
- **Crash-safe files.** Recordings are written as fragmented MP4 and turned into a standard MP4 on stop. If the PC crashes mid-recording, the file is still playable.

## Features

- Snipping Tool–style start: an overlay covers every connected screen; drag an area on any screen, or click the screen to record
- 3-2-1 countdown (Off / 3 / 5 / 10 s) centred on the area being recorded
- The app stays out of your recordings: the panel hides while you record, and the floating timer/Stop bar, the countdown and the review window are all excluded from capture
- Native, 1080p, 1440p or 4K output at 30 or 60 fps
- Quality presets: Very high (visually lossless), Maximum (4:4:4), High (smaller files), Lossless (archival)
- Audio: computer sound and/or any microphone or headset, each with its own on/off switch and volume, optional noise reduction, and live level meters. A *Test* button lets you check levels before recording.
- **Nothing is saved without your approval.** When you stop, the recording opens in a review window where you can:
  - preview it
  - trim it, or delete any parts (drag across the timeline, then *Keep only selection* or *Delete selection*)
  - crop it (free-form or 16:9 / 9:16 / 1:1 / 4:3)
  - then **Save**, **Save as…** or **Discard**

  Unedited saves are moved as-is, with no re-encode. Edited saves are re-encoded at the original quality.
- Unsaved recordings survive app restarts and crashes and wait for review
- `Ctrl+Shift+R` (Windows) / `Cmd+Shift+R` (macOS) global hotkey to start and stop
- Compact window: quick choices (screen, whole screen or region, audio on/off) sit under the record button, and everything else lives in a collapsible **Settings** section
- Tray icon that shows when you're recording

## Download

Every push to `main` builds both apps on GitHub Actions. Open the **Actions** tab and select the latest **Build apps** run.

**Windows**: download `screen-recorder-windows`. It contains:

- `Screen Recorder-Setup-<version>.exe`: installer
- `Screen Recorder-Portable-<version>.exe`: runs without installing

The app isn't code-signed, so Windows SmartScreen may warn on first launch. Click **More info → Run anyway**.

**macOS** (11 Big Sur or later): download `screen-recorder-mac`. Use `…-mac-arm64.dmg` on Apple Silicon (M1 or later) and `…-mac-x64.dmg` on Intel Macs. Open the DMG and drag **Screen Recorder** into **Applications**.

The app isn't notarised by Apple yet, so the first launch is blocked. Try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**. If macOS says the app "is damaged", run this once in Terminal:

```bash
xattr -cr "/Applications/Screen Recorder.app"
```

On first recording, macOS asks for **Screen & System Audio Recording** permission (and **Microphone**, if you turn it on). After granting screen permission, quit and reopen the app.

| | Windows | macOS |
| --- | --- | --- |
| Capture | Desktop Duplication on every monitor | AVFoundation, every display |
| Hardware encoding | NVIDIA / Intel / AMD | Apple VideoToolbox |
| Computer sound | Built in | macOS 13 Ventura or later |
| Microphone | Yes | Yes |

## Development

Requires Node.js 22.18 or newer.

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # unit tests + real FFmpeg encode tests
npm run dist       # build the Windows installer into dist/
```

| Path | Purpose |
| --- | --- |
| `src/main/args.ts` | Builds the FFmpeg capture/encode commands |
| `src/main/recorder.ts` | Runs FFmpeg, handles progress, stop and crash recovery |
| `src/main/ffmpeg.ts` | Locates FFmpeg; detects GPU encoders (incl. 4:4:4 support) and `ddagrab` |
| `src/main/displays.ts` | Maps each monitor to its DXGI adapter/output for Desktop Duplication |
| `src/main/audio.ts` | Computer-sound + mic capture, streamed to FFmpeg over a named pipe |
| `src/main/editor.ts` | Review window: save / save as / discard, trim + crop export |
| `src/main/mac-helper.ts`, `native/mac/MacHelper.swift` | macOS helper: display order for AVFoundation and computer sound via ScreenCaptureKit |
| `src/main/index.ts` | Electron app: windows, tray, hotkey, region selection |
| `src/renderer/` | Control panel, review editor, region overlay, audio capture page |
