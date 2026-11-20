# Testing checklist

Download the latest build from **GitHub → Actions → Build apps → newest run → Artifacts**: `screen-snap-windows` for Windows, `screen-snap-mac` for macOS (arm64 = Apple Silicon M1 or later, x64 = Intel).

If anything fails, send a screenshot plus the newest file from the logs folder. The **Open logs** link under any error opens it, or find it here:
- Windows: `%APPDATA%\Screen Snap\logs`
- macOS: `~/Library/Logs/Screen Snap`

## First launch

- [ ] **Windows:** SmartScreen warns (expected until the app is published to the Microsoft Store). Click **More info → Run anyway**.
- [ ] **macOS:** opening is blocked the first time (expected until the app is signed). Open **System Settings → Privacy & Security** and click **Open Anyway**. If macOS says the app "is damaged", run `xattr -cr "/Applications/Screen Snap.app"` in Terminal.
- [ ] **macOS:** on the first recording, allow **Screen & System Audio Recording**, then quit and reopen the app.

## Recording

- [ ] **Whole screen, one monitor:** press Record. The 3-2-1 countdown shows, then recording starts.
- [ ] **Whole screen, two monitors:** press Record. Both screens dim; hover highlights a screen, and clicking the **second** screen records that screen.
- [ ] **Select region:** drag an area on either screen. Only that area is recorded.
- [ ] **App hidden from recordings:** the panel disappears while recording. The floating bar (timer + Stop) and the countdown must **not** appear in the saved video, even when they're on the recorded screen.
- [ ] **Timer on the right screen:** with two monitors, record the second one: the countdown **and** the timer bar appear on that screen (not the main one), and neither is in the video.
- [ ] **Cancel:** ✕ Cancel on the bar during the countdown cancels; the recording shortcut also cancels or stops.
- [ ] **Shortcuts:** Alt+Shift+R (Windows) / Control+Option+R (macOS) starts and stops recording from any app. In a browser, Ctrl/Cmd+Shift+R (hard refresh) and Ctrl+Shift+I (developer tools) still work normally.
- [ ] **Settings → Shortcuts:** click a key box, press new keys; it works. *Off* turns one off; a combination another app already uses shows "unavailable".

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

## Screenshots

- [ ] **Screenshot tab → Select region:** every screen freezes and dims; drag an area on either screen. The review window opens with exactly that area, at full pixel size.
- [ ] **Whole screen:** with two monitors, click the screen you want; with one monitor the picture is taken straight away.
- [ ] **Nothing from Screen Snap** (the panel, review windows, the 3-2-1 countdown) is in the picture, even with a delay of 3 or 5 s.
- [ ] **Copy** puts the picture on the clipboard (paste it into Paint / Mail); **Save**, **Save as…** and **Discard** work, and nothing is saved before you press one.
- [ ] **Editing:** Crop, Pen, Highlighter, Arrow, Text, Undo and Redo work and are in the saved picture.
- [ ] **Formats:** PNG is the default with no warning; WebP and JPEG show a notice and save correctly.
- [ ] **Esc** cancels the selection and the panel comes back.
- [ ] **macOS:** allow **Screen & System Audio Recording** if asked, then quit and reopen the app.

## Save formats

- [ ] The default is **MP4 · H.264** with no warning, and it plays in Windows Media Player / QuickTime.
- [ ] Choosing MKV, MOV, H.265, WebM or GIF shows a notice; **Use MP4 (recommended)** puts it back.
- [ ] A saved MKV / MOV of an unedited recording is the same quality (no re-encode) and opens in VLC; H.265, WebM and GIF open in VLC (Windows Media Player may need an extra codec).
- [ ] The default can be changed in **Settings → Saving**.

## Settings window

- [ ] With Settings open, the window stays about the same height; scroll inside Settings, and the section names at the top jump to each section.
