const shade = document.getElementById('shade')!
const box = document.getElementById('box')!
const size = document.getElementById('size')!
const help = document.getElementById('help')!

let start: { x: number; y: number } | null = null
let rect = { x: 0, y: 0, width: 0, height: 0 }

function physical(n: number): number {
  return Math.round(n * window.devicePixelRatio)
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return window.overlay.done(null)
  start = { x: e.clientX, y: e.clientY }
  rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 }
  shade.classList.add('dragging')
  help.hidden = true
})

window.addEventListener('mousemove', (e) => {
  if (!start) return
  rect = {
    x: Math.min(start.x, e.clientX),
    y: Math.min(start.y, e.clientY),
    width: Math.abs(e.clientX - start.x),
    height: Math.abs(e.clientY - start.y)
  }
  Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  box.hidden = false
  size.textContent = `${physical(rect.width)} × ${physical(rect.height)}`
  size.style.top = rect.y < 30 ? '4px' : '-26px'
})

window.addEventListener('mouseup', () => {
  if (!start) return
  start = null
  if (rect.width < 16 || rect.height < 16) {
    shade.classList.remove('dragging')
    box.hidden = true
    help.hidden = false
    return
  }
  window.overlay.done(rect)
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.overlay.done(null)
})

window.addEventListener('contextmenu', (e) => e.preventDefault())
