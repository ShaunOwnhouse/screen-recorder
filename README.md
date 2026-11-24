# Screen Snap

A screen recorder and screenshot tool for Windows and macOS that keeps full HD, 1440p and 4K quality all the way to the saved file.

## Why the output stays sharp

Windows' built-in Snipping Tool recorder encodes at a low bitrate, which blurs text and fine detail. This app avoids that in a few ways:

- **Native resolution by default.** Every physical pixel on your screen is captured, including on scaled (125% / 150%) displays. Nothing is resized unless you choose an output size.
- **Constant-quality encoding.** It uses a quality target (CRF/CQ) rather than a bitrate cap, so busy scenes get the bits they need.
- **GPU encoding.** It detects NVIDIA (NVENC), Intel (Quick Sync) and AMD (AMF) encoders and uses the best one, so 4K60 runs in real time. NVENC uses adaptive quantisation, which puts bits into text and edges. If no GPU encoder is available it falls back to x264 on the CPU.
- **Fast capture on every monitor.** Each screen is matched to its own graphics adapter and output, so Desktop Duplication (`ddagrab`) works on any monitor, including mixed-scaling setups and laptops with two GPUs. GDI is only a fallback.
- **Clean colour conversion.** RGB is converted to video colour with accurate rounding and full-resolution chroma interpolation, so coloured text edges don't smear.
- **Optional 4:4:4 colour.** The *Studio* preset keeps full chroma resolution for VLC and video editors. The review window can convert these recordings to a play-everywhere copy.
- **Correct colour.** Video is converted and tagged as BT.709, so colours match your screen in every player.
- **Crash-safe files.** Recordings are written as fragmented MP4 and turned into a standard MP4 on stop. If the PC crashes mid-recording, the file is still playable.

## Features

- Snipping Tool–style start: an overlay covers every connected screen; drag an area on any screen, or click the screen to record
- 3-2-1 countdown (Off / 3 / 5 / 10 s) centred on the area being recorded
- The app stays out of your recordings: the panel hides while you record, and the floating timer/Stop bar, the countdown and the review window are all excluded from capture
- Native, 1080p, 1440p or 4K output at 30 or 60 fps
- Quality presets:
  - **Maximum** (default): near-lossless H.264 using the encoder's slowest, best settings. Plays everywhere, including Windows Media Player.
  - **Very high** and **High**: smaller files that also play everywhere.
  - **Studio 4:4:4** and **Lossless**: for colour-critical work in VLC or a video editor.
- 30, 60 or 120 fps
- Audio: computer sound and/or any microphone or headset, each with its own on/off switch and volume, optional noise reduction, and live level meters. A *Test* button lets you check levels before recording.
- **Nothing is saved without your approval.** When you stop, the recording opens in a review window where you can:
  - preview it, and **cut** it (Split at the playhead, delete a piece and the gap closes, drag the ends of a piece to trim; Undo / Redo for everything)
  - add **comments and callouts** that appear for as long as you choose: speech bubbles, sticky notes, plain text, arrows, highlight boxes, numbered steps, a **spotlight** that darkens everything except one spot, **blur / pixels** to hide private details, and **zoom in on an area** that glides in and back out. Drag them on the video, change colour / size / font / timing in the side panel, and they can fade in and out
  - add **other videos and pictures** (into the video at the playhead, with an optional cross-fade, or in a small **picture-in-picture** window), and **title cards** (dark, gradient or your brand colour)
  - add **as many audio files as you like** (music, voice-overs, sounds) — each is its own bar under the video: drag to move, drag its ends to trim, **Split**, **Duplicate**, volume, fade in / out, repeat, and *quieter while someone speaks*
  - **Separate the sound** of any video or of your recording into a sound of its own, then move, cut, turn down or save it
  - **Save pieces on their own**: a video without its sound, just its sound (MP3 / WAV / M4A), or the camera's picture or voice
  - **Duplicate** any piece of video, comment or sound (Ctrl+D)
  - set your own **brand colours and fonts** (Your brand… in the side panel) that are offered everywhere you can colour or write something
  - crop it (free-form or 16:9 / 9:16 / 1:1 / 4:3)
  - then **Save**, **Save as…** or **Discard**

  Unedited saves are moved as-is, with no re-encode. Edited saves are re-encoded at the original quality in a single pass; everything you drew is added at the saved video's own resolution, so it stays sharp.
- Unsaved recordings survive app restarts and crashes and wait for review
- **Face camera**: switch on **Camera** in the main section (pick which camera, with a live preview) and your webcam is recorded together with the screen — pause and resume pause it too, and your voice is recorded by the webcam's own microphone too. In the review window your face appears on the video by itself: drag it anywhere, resize it, make it a circle, rounded square or square, add a white border, move it to a corner, or nudge it if lips and voice are slightly out of step. **Whose sound to use**: by default the voice comes from the webcam's own recording, so picture and voice are one recording and always match; switch to the screen recording's sound (computer sounds included) with one click. When you cut the recording, the camera is cut with it. It is lined up with the screen by matching your voice in both recordings (or by when each started). It is saved into the finished video in every format, and the camera files are removed with the recording
- **Pause and resume**: the bar (and the panel and tray icon) has a Pause button; Resume carries on from the same point and the paused time is left out of the video. Under the hood a paused recording is captured in pieces with identical settings and joined without re-encoding when you stop (if a join ever can't be played, it is re-encoded instead; if a crash interrupts a paused recording, the pieces are joined the next time the app starts)
- Global shortcuts to start/stop a recording, pause/resume, and to take a screenshot from any app (default `Alt+Shift+R` / `Alt+Shift+P` / `Alt+Shift+S` on Windows, `Control+Option+R` / `Control+Option+P` / `Control+Option+S` on macOS). They deliberately avoid the keys browsers use (`Ctrl+Shift+R` hard refresh, `Ctrl+Shift+I` developer tools), and either can be changed or turned off in **Settings → Shortcuts**
- **Save in other formats.** MP4 · H.264 (what the app has always saved, and the default) plays everywhere. The review window can also save MKV or MOV (re-wrapped without re-encoding when you haven't edited), H.265 (smaller), WebM (VP9, for websites) or an animated GIF. Anything other than the default shows a notice about what may not open it; a default can be set in Settings
- **Screenshots**, with the same Snipping-Tool-style start: every screen freezes at its real pixel size, then you drag an area or click a screen (optional 3 / 5 s delay, optional cursor). A review window offers **Copy**, **Save**, **Save as…** and **Discard**, plus crop and pen / highlighter / arrow / text tools with undo and redo. PNG (lossless, exact pixels) is the default; WebP (lossless) and maximum-quality JPEG are available with a notice. The app's own windows are never in the picture
- Settings scroll inside a fixed-height area with shortcuts to each section, so the window stays compact
- Compact window: quick choices (screen, whole screen or region, audio on/off) sit under the record button, and everything else lives in a collapsible **Settings** section
- Tray icon that shows when you're recording

## Download

Every push to `main` builds both apps on GitHub Actions. Open the **Actions** tab and select the latest **Build apps** run.

**Windows**: download `screen-snap-windows`. It contains:

- `Screen Snap-Setup-<version>.exe`: installer
- `Screen Snap-Portable-<version>.exe`: runs without installing

The app isn't code-signed, so Windows SmartScreen may warn on first launch. Click **More info → Run anyway**.

**macOS** (11 Big Sur or later): download `screen-snap-mac`. Use `…-mac-arm64.dmg` on Apple Silicon (M1 or later) and `…-mac-x64.dmg` on Intel Macs. Open the DMG and drag **Screen Snap** into **Applications**.

The app isn't notarised by Apple yet, so the first launch is blocked. Try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**. If macOS says the app "is damaged", run this once in Terminal:

```bash
xattr -cr "/Applications/Screen Snap.app"
```

On first recording, macOS asks for **Screen & System Audio Recording** permission (and **Microphone**, if you turn it on). After granting screen permission, quit and reopen the app.

| | Windows | macOS |
| --- | --- | --- |
| Capture | Desktop Duplication on every monitor | AVFoundation, every display |
| Hardware encoding | NVIDIA / Intel / AMD | Apple VideoToolbox |
| Computer sound | Built in | macOS 13 Ventura or later |
| Microphone | Yes | Yes |

## Updates

The installed app **updates itself**. A few seconds after it starts (and every few hours after that) it looks for a newer version; if there is one it downloads it quietly in the background and shows a green banner, **Restart to update**. The update also installs when you simply close the app. Your settings and any unsaved recordings are kept, and the app never restarts in the middle of a recording. **Settings → Updates** has a **Check now** button and a switch to turn automatic downloads off.

- Install the **Setup** file once. After that you never download an installer again. The *Portable* file can't update itself.
- **macOS** can only replace itself once the app is code-signed (see below). Until then a Mac is told "Version X is available" with a button to the download page.
- Every build gets a higher version number automatically (`1.1.<build number>`), which is what lets an installed copy recognise a build as newer.
- A real Windows test runs on every build before it is published: it installs the previous build silently, lets it find the new one on a local feed, downloads it, restarts into it and checks the version, the settings and the "up to date" message.

### Where updates come from

Installed copies read an update feed (`latest.yml` plus the installer) over the internet. **This repository is private, so installed copies can't read from it.** Pick one:

1. **A public, releases-only repository (recommended; the code stays private).**
   1. Create a new public repository, for example `screen-snap-updates`, and add a README so it isn't empty.
   2. Create a fine-grained access token (GitHub → Settings → Developer settings → Fine-grained tokens) for *only that repository* with **Contents: Read and write**.
   3. In this repository → Settings → Secrets and variables → Actions: add the secret `UPDATE_FEED_TOKEN` (the token) and the variable `UPDATE_FEED_REPO` (`YourName/screen-snap-updates`).
   4. Push. From the next build, new versions are published there and installed copies find them.
2. **Make this repository public.** Then the default feed (this repository's `updates` release) works with nothing else to set up.
3. **Your own web server.** Set the variable `UPDATE_FEED_URL` to the folder that holds `latest.yml`, and upload the files from each build there.

## Removing the security warning

Windows SmartScreen ("Windows protected your PC") and macOS Gatekeeper warn about any app that isn't **code-signed** by a verified publisher. Only a signing certificate removes the warning. The build is already set up for it: add the secrets below under **GitHub → Settings → Secrets and variables → Actions**, push, and the next build is signed automatically.

### Windows (pick one)

| Option | Cost (approx., check current pricing) | Notes |
| --- | --- | --- |
| **Microsoft Store** | Free for individual developers | Microsoft signs Store apps, so there's no warning at all, plus automatic updates. The build already makes the Store package; follow [store/README.md](store/README.md). |
| **Azure Trusted Signing** | ~US$10 / month | Cheapest signing for direct downloads. Microsoft must verify your identity; check that your country and account type are eligible. |
| **OV code-signing certificate** (e.g. SSL.com, Sectigo, Certum) | ~US$100–400 / year | The certificate lives on a hardware token or in a cloud HSM. SmartScreen can still warn for the first weeks while the certificate builds reputation. |

Secrets for **Azure Trusted Signing**: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (an app registration with the *Trusted Signing Certificate Profile Signer* role), `AZURE_SIGN_ENDPOINT` (e.g. `https://eus.codesigning.azure.net/`), `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`.

Secrets for a **.pfx certificate**: `WIN_CSC_LINK` (the .pfx file, base64-encoded) and `WIN_CSC_KEY_PASSWORD`.

### macOS

Join the **Apple Developer Program** (US$99 / year), create a **Developer ID Application** certificate, export it as a .p12, and add:

- `MAC_CSC_LINK`: the .p12, base64-encoded (`base64 -i cert.p12 | pbcopy`)
- `MAC_CSC_KEY_PASSWORD`: the .p12 password
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (create one at appleid.apple.com), `APPLE_TEAM_ID`

The build then signs with the hardened runtime and notarises with Apple, so the app opens with no warning.

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
| `src/main/editor.ts` | Review window: added files, waveform / timeline pictures, brand fonts, save / save as / discard |
| `src/main/project-export.ts` | Turns an edited project (clips, fades, comments, blur, zoom, picture-in-picture, music) into one FFmpeg command, for every save format |
| `src/shared/project.ts` | The editor's project model: clips, overlays, music, and the cut / trim / insert rules |
| `src/main/mac-helper.ts`, `native/mac/MacHelper.swift` | macOS helper: display order for AVFoundation and computer sound via ScreenCaptureKit |
| `src/main/index.ts` | Electron app: windows, tray, hotkey, region selection |
| `src/renderer/` | Control panel, region overlay, audio capture page |
| `src/renderer/editor/` | The editor: player, timeline, stage interaction, side panels, drawing, brand kit |
