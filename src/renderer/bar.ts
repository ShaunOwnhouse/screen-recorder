import type { RecordingStatus } from '../shared/types.ts'

const api = window.api
const bar = document.getElementById('bar')!
const text = document.getElementById('text')!
const stop = document.getElementById('stop')!
const cancel = document.getElementById('cancel')!

function formatTime(seconds: number): string {
  const s = Math.floor(seconds)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

function render(s: RecordingStatus): void {
  bar.className = `bar ${s.state}`
  stop.hidden = s.state !== 'recording'
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
        : s.state === 'saving'
          ? 'Finishing…'
          : ''
}

stop.addEventListener('click', () => void api.toggleRecording())
cancel.addEventListener('click', () => void api.toggleRecording())
api.onStatus(render)
void api.getStatus().then(render)
