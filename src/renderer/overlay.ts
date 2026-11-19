// One of these covers each connected screen while the user picks what to record.
const params = new URLSearchParams(location.search)
const mode = params.get('mode') === 'screen' ? 'screen' : 'region'
const label = params.get('label') ?? 'This screen'
const size = params.get('size') ?? ''

const shade = document.getElementById('shade')!
const box = document.getElementById('box')!
const sizeEl = document.getElementById('size')!
const help = document.getElementById('help')!

document.body.classList.add(mode)
help.innerHTML =
  mode === 'screen'
    ? 'Click the screen you want to record · <kbd>Esc</kbd> to cancel'
    : 'Drag to select the area to record · <kbd>Esc</kbd> to cancel'
document.getElementById('card-title')!.textContent = `Record ${label}`
document.getElementById('card-detail')!.textContent = `${size} · Click to start`

const cancel = (): void => window.overlay.done(null)
window.addEventListener('keydown', (e) => e.key === 'Escape' && cancel())
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  cancel()
})

if (mode === 'screen') {
  const setHover = (on: boolean): void => {
    document.body.classList.toggle('hover', on)
  }
  document.addEventListener('mouseenter', () => setHover(true))
  document.addEventListener('mouseleave', () => setHover(false))
  document.addEventListener('mousemove', () => setHover(true), { once: true })
  if (params.get('active') === '1') setHover(true)
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) window.overlay.done({ screen: true })
  })
} else {
  let start: { x: number; y: number } | null = null
  let rect = { x: 0, y: 0, width: 0, height: 0 }
  const physical = (n: number): number => Math.round(n * window.devicePixelRatio)

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    start = { x: e.clientX, y: e.clientY }
    rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 }
    shade.classList.add('dragging')
    help.hidden = true
  })

  window.addEventListener('mousemove', (e) => {
    if (!start) return
    // Clamp to this screen: a recording can only cover one monitor.
    const x = Math.min(Math.max(e.clientX, 0), window.innerWidth)
    const y = Math.min(Math.max(e.clientY, 0), window.innerHeight)
    rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) }
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    box.hidden = false
    sizeEl.textContent = `${physical(rect.width)} × ${physical(rect.height)}`
    sizeEl.style.top = rect.y < 30 ? '4px' : '-26px'
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
    window.overlay.done({ rect })
  })
}
