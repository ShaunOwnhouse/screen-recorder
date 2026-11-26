/** The bars that let the person drag to give the picture, the timeline or the side panels more room. */

const KEY = 'screen-snap-editor-layout'

interface Saved {
  /** The timeline's share of the window height (a pixel height is converted when it is first read). */
  tlFrac?: number
  tl?: number
  drawer?: number
  props?: number
  noDrawer?: boolean
}

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved
  } catch {
    return {}
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // a remembered layout is only a convenience
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function drag(grip: HTMLElement, onMove: (e: PointerEvent, start: { x: number; y: number }) => void, onEnd: () => void, onStart: () => void): void {
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('drag')
    const start = { x: e.clientX, y: e.clientY }
    onStart()
    const move = (ev: PointerEvent): void => onMove(ev, start)
    const up = (): void => {
      grip.classList.remove('drag')
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      onEnd()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  })
}

export function initLayout(onChange: () => void): void {
  const root = document.querySelector<HTMLElement>('.editor')!
  const work = document.querySelector<HTMLElement>('.work')!
  const saved = load()
  const set = (name: string, px: number): void => root.style.setProperty(name, `${Math.round(px)}px`)
  // the timeline starts with room for every row (it is taller on a tall window); the person can drag it anyway. It keeps its
  // share of the window, so a window that is maximised or moved to another screen gets a timeline that suits it.
  const share = (): number => saved.tlFrac ?? (saved.tl ? saved.tl / Math.max(400, window.innerHeight) : 0)
  const fitTimeline = (): void => {
    const h = share() ? window.innerHeight * share() : clamp(window.innerHeight * 0.42, 300, 500)
    set('--tl-h', clamp(h, 140, Math.max(140, window.innerHeight - 300)))
  }
  fitTimeline()
  window.addEventListener('resize', () => {
    fitTimeline()
    onChange()
  })
  if (saved.drawer) set('--drawer-w', saved.drawer)
  if (saved.props) set('--props-w', saved.props)
  work.classList.toggle('no-drawer', !!saved.noDrawer)

  // picture ↔ timeline
  const gt = document.getElementById('grip-timeline')!
  let tl0 = 0
  drag(
    gt,
    (e, s) => {
      const h = clamp(tl0 - (e.clientY - s.y), 140, window.innerHeight - 260)
      set('--tl-h', h)
      saved.tlFrac = h / Math.max(400, window.innerHeight)
      delete saved.tl
      onChange()
    },
    () => save(saved),
    () => (tl0 = document.querySelector<HTMLElement>('.tl-wrap')!.getBoundingClientRect().height)
  )
  gt.addEventListener('dblclick', () => {
    delete saved.tl
    delete saved.tlFrac
    fitTimeline()
    save(saved)
    onChange()
  })

  // left panel
  const gd = document.getElementById('grip-drawer')!
  let d0 = 0
  drag(
    gd,
    (e, s) => {
      const w = clamp(d0 + (e.clientX - s.x), 160, 520)
      work.classList.remove('no-drawer')
      saved.noDrawer = false
      set('--drawer-w', w)
      saved.drawer = w
      onChange()
    },
    () => save(saved),
    () => (d0 = document.getElementById('drawer')!.getBoundingClientRect().width || 228)
  )
  gd.addEventListener('dblclick', () => {
    work.classList.toggle('no-drawer')
    saved.noDrawer = work.classList.contains('no-drawer')
    save(saved)
    onChange()
  })

  // right panel
  const gp = document.getElementById('grip-props')!
  let p0 = 0
  drag(
    gp,
    (e, s) => {
      const w = clamp(p0 - (e.clientX - s.x), 180, 520)
      set('--props-w', w)
      saved.props = w
      onChange()
    },
    () => save(saved),
    () => (p0 = document.getElementById('props')!.getBoundingClientRect().width || 252)
  )
  gp.addEventListener('dblclick', () => {
    root.style.removeProperty('--props-w')
    delete saved.props
    save(saved)
    onChange()
  })
}
