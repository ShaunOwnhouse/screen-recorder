import { envAt, envDip, envPut, envRamp, envRemove, type EnvPoint } from '../../shared/project.ts'
import { button, h, toggle } from './dom.ts'
import { clampNum, type Store } from './store.ts'

const NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag: string, attrs: Record<string, string | number> = {}): SVGElement => {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/** The line's time and level at the pointer, and how many seconds the thing it belongs to lasts. */
export interface LevelSpec {
  /** Shown above the graph, e.g. "Volume over time". */
  title: string
  /** What 0 means in this graph: "silent" for sounds, "hidden" for the camera picture. */
  low: string
  id: string
  /** Read live (the thing may have been split or trimmed since the panel was built). */
  line: () => EnvPoint[] | undefined
  /** Where the line's 0 is on the timeline, and how long it lasts. */
  span: () => { origin: number; length: number }
  set: (env: EnvPoint[] | undefined, merge: string) => void
  /** Short hint under the buttons. */
  tip?: string
}

/**
 * A small graph of how loud (or how visible) something is over time, with buttons for the common moves and a "record while
 * playing" mode, where moving the Level slider as the video plays draws the line.
 */
export function levelEditor(store: Store, spec: LevelSpec): HTMLElement {
  const PAD = 10
  const H = 92
  const svg = svgEl('svg', { class: 'lvl-svg', height: H, id: `${spec.id}-graph` }) as SVGSVGElement
  let recording = false
  let lastRel = -1
  let sliding = false
  let drag = -1
  const slider = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 1, id: `${spec.id}-level` })
  const sliderVal = h('span', { class: 'range-val', text: '100%' })

  let root!: HTMLElement
  const rel = (): number => {
    const { origin, length } = spec.span()
    return clampNum(store.playhead - origin, 0, length)
  }
  const write = (env: EnvPoint[] | undefined): void => spec.set(env && env.length ? env : undefined, `lvl:${spec.id}`)

  const geometry = (): { W: number; x: (t: number) => number; y: (v: number) => number; t: (x: number) => number; v: (y: number) => number; length: number } => {
    const W = Math.max(120, svg.clientWidth || 260)
    const { length } = spec.span()
    const span = Math.max(0.1, length)
    return {
      W, length,
      x: (t) => PAD + clampNum(t / span, 0, 1) * (W - PAD * 2),
      y: (v) => PAD + (1 - clampNum(v, 0, 1)) * (H - PAD * 2),
      t: (x) => clampNum(((x - PAD) / (W - PAD * 2)) * span, 0, span),
      v: (y) => clampNum(1 - (y - PAD) / (H - PAD * 2), 0, 1)
    }
  }

  const draw = (): void => {
    const g = geometry()
    const env = spec.line()
    svg.setAttribute('viewBox', `0 0 ${g.W} ${H}`)
    svg.setAttribute('width', String(g.W))
    const kids: Element[] = []
    for (const v of [1, 0.5, 0]) kids.push(svgEl('line', { class: 'lvl-grid', x1: PAD, x2: g.W - PAD, y1: g.y(v), y2: g.y(v) }))
    const pts = env ?? []
    const poly: Array<[number, number]> = [[PAD, g.y(envAt(env, 0))], ...pts.filter((p) => p.t > 0 && p.t < g.length).map((p): [number, number] => [g.x(p.t), g.y(p.v)]), [g.W - PAD, g.y(envAt(env, g.length))]]
    kids.push(svgEl('polyline', { class: 'lvl-line', points: poly.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ') }))
    const here = rel()
    kids.push(svgEl('line', { class: 'lvl-head', x1: g.x(here), x2: g.x(here), y1: 2, y2: H - 2 }))
    pts.forEach((p, i) => {
      if (p.t > g.length + 1e-6) return
      kids.push(svgEl('circle', { class: `lvl-pt${i === drag ? ' on' : ''}`, cx: g.x(p.t), cy: g.y(p.v), r: 6, 'data-i': i }))
      // a bigger invisible target around each point, so it is easy to catch with the mouse
      kids.push(svgEl('circle', { class: 'lvl-hit', cx: g.x(p.t), cy: g.y(p.v), r: 14, 'data-i': i }))
    })
    svg.replaceChildren(...kids)
    const now = envAt(env, here)
    if (!sliding) {
      ;(slider as HTMLInputElement).value = String(now)
      sliderVal.textContent = `${Math.round(now * 100)}%`
    }
  }

  // ---- drag points around, click to add one, double-click to remove ----
  const localPoint = (e: PointerEvent): { x: number; y: number } => {
    const r = svg.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  svg.addEventListener('pointerdown', (e) => {
    const g = geometry()
    const { x, y } = localPoint(e)
    const hit = (e.target as Element).getAttribute?.('data-i')
    const env = spec.line()
    if (hit !== null && hit !== undefined) {
      drag = Number(hit)
    } else {
      const t = g.t(x)
      const next = envPut(env, t, g.v(y))
      write(next)
      drag = next.findIndex((p) => Math.abs(p.t - t) < 0.05)
    }
    root.dataset.busy = '1'
    svg.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  svg.addEventListener('pointermove', (e) => {
    if (drag < 0) return
    const env = spec.line()
    if (!env || !env[drag]) return
    const g = geometry()
    const { x, y } = localPoint(e)
    const lo = drag > 0 ? env[drag - 1].t + 0.05 : 0
    const hi = drag < env.length - 1 ? env[drag + 1].t - 0.05 : g.length
    const next = env.map((p, i) => (i === drag ? { t: clampNum(g.t(x), lo, Math.max(lo, hi)), v: g.v(y) } : p))
    write(next)
  })
  const stop = (): void => {
    if (drag >= 0) store.endMerge()
    drag = -1
    delete root.dataset.busy
    // not at once: replacing the dot under the pointer before the click has finished would stop the click (and double-click) happening
    setTimeout(draw, 0)
  }
  svg.addEventListener('pointerup', stop)
  svg.addEventListener('pointercancel', stop)
  // the pointer is captured while pressing, so the point is found by where it is rather than by what was hit
  svg.addEventListener('dblclick', (e) => {
    const env = spec.line() ?? []
    const g = geometry()
    const { x, y } = localPoint(e as PointerEvent)
    let best = -1
    let bd = 12
    env.forEach((p, i) => {
      const d = Math.hypot(g.x(p.t) - x, g.y(p.v) - y)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    if (best < 0) return
    write(envRemove(env, best))
    store.endMerge()
  })

  // ---- the quick moves ----
  const move = (fn: (env: EnvPoint[] | undefined, t: number, length: number) => EnvPoint[]): void => {
    const { length } = spec.span()
    write(fn(spec.line(), rel(), length))
    store.endMerge()
  }
  const buttons = h('div', { class: 'lvl-buttons' },
    button('＋ Dip here', () => move((env, t, length) => envDip(env, t, Math.max(0.5, Math.min(3, length - t - 0.9)))), 'ghost small', { id: `${spec.id}-dip`, title: `Go quiet for a few seconds from the playhead, then come back` }),
    button('Fade out from here', () => move((env, t) => envRamp(env, t, 0, 1.5)), 'ghost small', { id: `${spec.id}-out`, title: `Glide down to ${spec.low} from the playhead and stay there` }),
    button('Fade up from here', () => move((env, t) => envRamp(env, t, 1, 1.5)), 'ghost small', { id: `${spec.id}-up`, title: 'Glide back up to full from the playhead' }),
    button('Clear', () => { write(undefined); store.endMerge() }, 'ghost small', { id: `${spec.id}-clear`, title: 'Take the whole line away' })
  )

  // ---- record while playing ----
  const sliderRow = h('div', { class: 'range lvl-rec', hidden: true }, slider, sliderVal)
  const put = (final: boolean): void => {
    const v = Number((slider as HTMLInputElement).value)
    sliderVal.textContent = `${Math.round(v * 100)}%`
    const t = rel()
    if (!final && store.playing && lastRel >= 0 && Math.abs(t - lastRel) < 0.08) return
    let env = spec.line() ?? []
    if (store.playing) {
      // what was there between the last point written and this one is replaced by what is being played now
      const from = lastRel >= 0 ? lastRel : t - 0.05
      env = env.filter((p) => p.t <= from + 1e-6 || p.t > t + 1e-6)
    }
    write(envPut(env, t, v))
    lastRel = t
  }
  slider.addEventListener('pointerdown', () => { sliding = true; lastRel = -1; root.dataset.busy = '1' })
  slider.addEventListener('input', () => { if (recording) put(false) })
  slider.addEventListener('change', () => {
    if (recording) put(true)
    sliding = false
    lastRel = -1
    delete root.dataset.busy
    store.endMerge()
  })
  const rec = toggle('● Record while playing', false, (on) => {
    recording = on
    sliderRow.hidden = !on
    if (on) draw()
  }, `${spec.id}-rec`)

  root = h('div', { class: 'psec lvl', id: spec.id },
    h('h3', { text: spec.title }),
    svg,
    buttons,
    rec,
    sliderRow,
    h('p', { class: 'tip', text: spec.tip ?? `Click the graph to add a point, drag a point to move it, double-click a point to remove it. Down is ${spec.low}.` })
  )

  let seen = false
  const off = store.on((what) => {
    if (root.isConnected) seen = true
    else if (seen) {
      off()
      return
    }
    if (what === 'project' || what === 'playhead' || what === 'selection') draw()
  })
  // measured once it is on the page
  requestAnimationFrame(draw)
  draw()
  return root
}

/** A thin line over a bar on the timeline: the level from `from` to `to` (timeline seconds), `px` pixels per second. */
export function levelLine(env: EnvPoint[] | undefined, origin: number, from: number, to: number, px: number, height: number, cls = 'lvl-tl'): SVGElement | null {
  if (!env || !env.length) return null
  const PAD = 4
  const width = Math.max(1, (to - from) * px)
  const svg = svgEl('svg', { class: cls, width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' })
  const y = (v: number): number => PAD + (1 - clampNum(v, 0, 1)) * (height - PAD * 2)
  const at = (t: number): number => envAt(env, t - origin)
  const pts: Array<[number, number]> = [[0, y(at(from))]]
  for (const p of env) {
    const t = p.t + origin
    if (t > from && t < to) pts.push([(t - from) * px, y(p.v)])
  }
  pts.push([width, y(at(to))])
  svg.append(svgEl('polyline', { points: pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ') }))
  for (const [a, b] of pts.slice(1, -1)) svg.append(svgEl('circle', { cx: a, cy: b, r: 2.6 }))
  return svg
}
