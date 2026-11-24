import type { RecordingStatus } from '../shared/types.ts'

const api = window.api
const bar = document.getElementById('bar')!
const text = document.getElementById('text')!
const stop = document.getElementById('stop')!
const camDot = document.getElementById('cam')!
const pause = document.getElementById('pause') as HTMLButtonElement
const pauseText = document.getElementById('pause-text')!
const pauseIcon = pause.querySelector('.ico')!
const cancel = document.getElementById('cancel')!

function formatTime(seconds: number): string {
  const s = Math.floor(seconds)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

function render(s: RecordingStatus): void {
  bar.className = `bar ${s.state}`
  const live = s.state === 'recording' || s.state === 'paused'
  stop.hidden = !live
  pause.hidden = !live
  camDot.hidden = !(live && s.camera)
  pause.disabled = Boolean(s.resuming)
  pause.title = s.state === 'paused' ? 'Carry on recording' : 'Pause recording'
  pauseText.textContent = s.state === 'paused' ? 'Resume' : 'Pause'
  pauseIcon.className = `ico ${s.state === 'paused' ? 'play' : 'bars'}`
  cancel.hidden = s.state !== 'countdown' || s.countdown === 0
  text.textContent =
    s.state === 'countdown'
      ? s.countdown === undefined
        ? 'Getting ready…'
        : s.countdown
          ? `Starting in ${s.countdown}…`
          : 'Recording…'
      : s.state === 'recording'
        ? formatTime(s.elapsed)
        : s.state === 'paused'
          ? s.resuming
            ? 'Resuming…'
            : `Paused ${formatTime(s.elapsed)}`
        : s.state === 'saving'
          ? 'Finishing…'
          : ''
}

stop.addEventListener('click', () => void api.toggleRecording())
pause.addEventListener('click', () => void api.togglePause())
cancel.addEventListener('click', () => void api.toggleRecording())
api.onStatus(render)
void api.getStatus().then(render)
