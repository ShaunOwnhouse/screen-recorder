# Screen Recorder

A Windows screen recorder that keeps full HD, 1440p and 4K quality all the way to the saved file.

## Why the output stays sharp

Windows' built-in Snipping Tool recorder encodes at a low bitrate, which blurs text and fine detail. This app avoids that in a few ways:

- **Native resolution by default.** Every physical pixel on your screen is captured, including on scaled (125% / 150%) displays. Nothing is resized unless you choose an output size.
- **Constant-quality encoding.** It uses a quality target (CRF/CQ) rather than a bitrate cap, so busy scenes get the bits they need.
- **GPU encoding.** It detects NVIDIA (NVENC), Intel (Quick Sync) and AMD (AMF) encoders and uses the best one, so 4K60 runs in real time. If none is available it falls back to x264 on the CPU.
- **Fast capture.** It uses Desktop Duplication (`ddagrab`) on the main monitor and GDI elsewhere.
- **Correct colour.** Video is converted and tagged as BT.709, so colours match your screen in every player.
- **Crash-safe files.** Recordings are written as fragmented MP4 and turned into a standard MP4 on stop. If the PC crashes mid-recording, the file is still playable.

## Features

- Full screen or a dragged region, on any monitor
- Native, 1080p, 1440p or 4K output at 30 or 60 fps
- Quality presets: Very high (visually lossless), High (smaller files), Lossless (archival)
- Optional audio from a microphone or "Stereo Mix" (computer sound)
- `Ctrl+Shift+R` global hotkey to start and stop
- Tray icon that shows when you're recording
- The control window never appears in your recordings

## Download

Every push to `main` builds the app on GitHub Actions. Open the **Actions** tab, select the latest **Build Windows app** run, and download `screen-recorder-windows`. It contains:

- `Screen Recorder-Setup-<version>.exe`: installer
- `Screen Recorder-Portable-<version>.exe`: runs without installing

The app isn't code-signed, so Windows SmartScreen may warn on first launch. Click **More info → Run anyway**.

## Development

Requires Node.js 22+.

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
| `src/main/ffmpeg.ts` | Locates FFmpeg; detects GPU encoders, `ddagrab` and audio devices |
| `src/main/index.ts` | Electron app: window, tray, hotkey, region selection |
| `src/renderer/` | Control panel UI and region-selection overlay |
