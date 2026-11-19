# Testing checklist

Download the latest build from **GitHub → Actions → Build apps → newest run → Artifacts**: `screen-recorder-windows` for Windows, `screen-recorder-mac` for macOS (arm64 = Apple Silicon M1 or later, x64 = Intel).

If anything fails, send a screenshot plus the newest file from the logs folder. The **Open logs** link under any error opens it, or find it here:
- Windows: `%APPDATA%\Screen Recorder\logs`
- macOS: `~/Library/Logs/Screen Recorder`

## First launch

- [ ] **Windows:** SmartScreen warns (expected until the app is published to the Microsoft Store). Click **More info → Run anyway**.
- [ ] **macOS:** opening is blocked the first time (expected until the app is signed). Open **System Settings → Privacy & Security** and click **Open Anyway**. If macOS says the app "is damaged", run `xattr -cr "/Applications/Screen Recorder.app"` in Terminal.
- [ ] **macOS:** on the first recording, allow **Screen & System Audio Recording**, then quit and reopen the app.

## Recording

- [ ] **Whole screen, one monitor:** press Record. The 3-2-1 countdown shows, then recording starts.
- [ ] **Whole screen, two monitors:** press Record. Both screens dim; hover highlights a screen, and clicking the **second** screen records that screen.
- [ ] **Select region:** drag an area on either screen. Only that area is recorded.
- [ ] **App hidden from recordings:** the panel disappears while recording. The floating bar (timer + Stop) and the countdown must **not** appear in the saved video, even when they're on the recorded screen.
- [ ] **Cancel:** ✕ Cancel on the bar during the countdown cancels; Ctrl/Cmd+Shift+R also cancels or stops.
- [ ] **Hotkey:** Ctrl+Shift+R (Windows) / Cmd+Shift+R (macOS) starts and stops recording from any app.

## Audio

- [ ] **Computer sound only:** play a YouTube video while recording; it's audible in the saved file. On macOS this needs macOS 13 or later.
- [ ] **Microphone only:** your voice is audible, and the mic list shows your headset.
- [ ] **Both:** voice and computer sound are mixed at the volumes set in Settings → Audio.
- [ ] **Test** button in Settings → Audio: the level meters move.

## Review and save

- [ ] After Stop, the review window opens and the video plays.
- [ ] **Trim:** drag across the timeline → *Delete selection*. Playback skips the grey part, and the saved file is shorter.
- [ ] **Crop:** crop to 16:9; the saved file has the cropped size.
- [ ] **Save / Save as… / Discard** all work; Discard asks for confirmation first.
- [ ] Nothing is saved to your folder until you click Save.

## Quality and playback

- [ ] With **Maximum** quality, the saved MP4 plays in **Windows Media Player** / **QuickTime**, on a phone, and in a browser.
- [ ] Small text in the recording is as sharp as on screen.
- [ ] The info line in the review window shows your screen's full resolution (e.g. 1920×1080 or 3840×2160).
- [ ] Recording for 2–3 minutes shows no yellow "encoding slower than real time" warning on the bar or panel.
