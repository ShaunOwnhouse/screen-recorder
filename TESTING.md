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
- [ ] **Pause / resume:** while recording, click **Pause** on the bar (or press Alt+Shift+P / Control+Option+P, or use the tray icon). The timer stops and says *Paused*. Do something different on screen, then **Resume**: the timer carries on from where it stopped. Stop and play it back: the paused part is not in the video, the picture and sound carry on smoothly across the join. Also try Stop while paused.
- [ ] **Face camera:** switch on **Camera** in the main section (you should see yourself in the little preview; try another camera in the list if you have one). Record a short talk with the microphone on, pause and resume once, stop. In the review window your face is on the video: drag it, resize it, try Circle / Rounded / Square and the corners. Play it — your lips and voice should match (the webcam's own sound is used by default; *Whose sound to use* switches it to the screen recording's). Cut part of the recording and check the camera is cut with it. Save and play the file back.
- [ ] **Settings → Shortcuts:** click a key box, press new keys; it works. *Off* turns one off; a combination another app already uses shows "unavailable".

## Audio

- [ ] **Computer sound only:** play a YouTube video while recording; it's audible in the saved file. On macOS this needs macOS 13 or later.
- [ ] **Microphone only:** your voice is audible, and the mic list shows your headset.
- [ ] **Both:** voice and computer sound are mixed at the volumes set in Settings → Audio.
- [ ] **Test** button in Settings → Audio: the level meters move.

## Review and save

- [ ] After Stop, the review window opens and the video plays.
- [ ] **Cut:** move the playhead, press *Split here* (or **S**), click a piece and press *Delete*. The gap closes and the saved file is shorter. Drag the ends of a piece to trim it. *Undo* / *Redo* (Ctrl+Z / Ctrl+Y) work.
- [ ] **Comments:** *Comments → Add a comment*, type words, drag it on the video, change colour and size. It shows only between its start and end (change these in the side panel or by dragging it on the timeline). Play the video and save: it is in the saved file in the same place.
- [ ] **Shapes:** arrow, highlight box, numbered step, spotlight, blur / pixels (hide a name on screen) and zoom (drag its box over a part of the screen — the saved video glides in and back out).
- [ ] **Other video / pictures:** *Media → Add a video or picture* puts it into the video at the playhead; tick *Fade in from the piece before* for a cross-fade. *Add as picture-in-picture* shows it in a small window you can drag and resize.
- [ ] **Audio:** *Audio → Add audio files* and choose two or three songs/sounds at once. Each is its own bar: drag, trim the ends, **Split**, **Duplicate**; change volume, fades, *Repeat* and *Quieter while someone speaks*. Hear them all in the saved video.
- [ ] **Two sounds:** record while playing a video (computer sound) and speaking (microphone). In the review window click the recording: *Sound from the recording* offers Everything / Computer sound only / My microphone only — play each. With the face camera on, check your voice comes from the webcam while the video's sound stays.
- [ ] **Speed:** in the save bar choose *Speed* 2× and 0.5×; save and check the length and that the voice keeps its normal pitch.
- [ ] **Separate the sound:** click a video piece (or the recording) → *Separate the sound*. The piece goes silent and a blue sound bar appears under it; move it, cut it, turn it down. Try *Save video only…* and *Save sound only…* (MP3/WAV/M4A) and play the saved files.
- [ ] **Title card:** *Titles* → pick a style → change the words; it is in the saved video.
- [ ] **Brand:** *Your brand colours & fonts…* → add a colour and a font file; they appear in the colour rows and font lists.
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

## Updates

- [ ] **First install:** install with the **Setup** file (the Portable file can't update itself). Settings → Updates shows the version number.
- [ ] **Check now:** says "You're up to date." when there is nothing newer.
- [ ] **A newer build exists:** after a few seconds a green banner says "Version X is ready … Restart to update". Click it: the app closes, installs and starts again by itself, and Settings → Updates shows the new version. Your settings and any recordings waiting for review are still there.
- [ ] **Not during a recording:** with the banner showing, start a recording; the app must not restart. Finish the recording, then restart works.
- [ ] **macOS (until the app is code-signed):** Settings → Updates says a new version is available and the button opens the download page; the update itself is installed by hand.

- [ ] **Tracks:** in the review window press **+ Video track** and **+ Audio track** (small buttons in the left column of the timeline). Add two or three videos, pictures and audio files: they go on the row that has room, or on a new one. Slide a piece up and down between rows and along a row (it snaps to the playhead and to other pieces). Try **Duplicate** (the copy appears on a row above and can be dragged before the original), the **hide / mute / lock** buttons on a row, and **Delete** versus **Shift+Delete**.
- [ ] **Speed and fades per piece:** click a piece, set its **Speed** (¼×–4×) and watch it get shorter or longer on the timeline; set **Fade in from** black/white/see-through and **Fade out to** a colour. Play it, then **Preview final video** and check the picture and the sound follow.
- [ ] **Volume / visibility over time:** add a song, then a voice (a recording or voice-over). Select the song, put the playhead where the voice starts and click **＋ Dip here** in *Volume over time*: the music should drop for a few seconds and come back (yellow line on its bar). Try **Fade out from here**, dragging points, and **Record while playing** (play, move the *Level* slider). Select the face camera and **＋ Dip here** under *Show the camera over time*: just the picture fades away and returns. Play it, then save and check the music dips and the camera vanishes at the same moments.
- [ ] **Layout:** drag the bars between the picture, the timeline and the side panels on a small window; double-click a bar to reset it.
- [ ] **Keep editing:** save, then press **Keep editing** and change something, save again; **Finish** removes the recording and leaves your saved videos.
