import { newClipBase, newId, type Clip, type Overlay, type TitleCard } from '../../shared/project.ts'
import type { MediaInfo } from '../../shared/types.ts'
import type { Store } from './store.ts'

export type NewKind = 'bubble' | 'note' | 'text' | 'arrow' | 'box' | 'step' | 'spotlight' | 'blur' | 'zoom'

/** The first colour in the person's brand, for things that should look like theirs by default. */
const accent = (s: Store): string => s.brand.colors[0] ?? '#ef4444'

/** Where a new overlay goes on the time line: from the playhead, for a few seconds. */
export function windowFor(s: Store, seconds: number): { start: number; end: number } {
  const total = s.duration
  let start = s.snap(Math.min(s.playhead, Math.max(0, total - 0.5)))
  const end = Math.min(total, start + seconds)
  if (end - start < Math.min(seconds, total) - 1e-6) start = Math.max(0, end - seconds)
  return { start: s.snap(start), end: s.snap(end) }
}

export function newOverlay(kind: NewKind, s: Store): Overlay {
  const w = windowFor(s, kind === 'zoom' ? 5 : 4)
  const base = { id: newId('o'), ...w, fade: true }
  switch (kind) {
    case 'bubble':
      return { ...base, kind, x: 0.3, y: 0.3, w: 0.3, text: 'Type your comment here', size: 34, color: '#111827', bg: '#ffffff', font: 'sans', align: 'left', tx: 0.5, ty: 0.62 }
    case 'note':
      return { ...base, kind, x: 0.08, y: 0.12, w: 0.24, text: 'Remember this part', size: 30, color: '#1f2937', bg: '#fde047', font: 'sans', align: 'left', tx: 0.5, ty: 0.5 }
    case 'text':
      return { ...base, kind, x: 0.25, y: 0.42, w: 0.5, text: 'Your text', size: 64, color: '#ffffff', bg: '', font: 'sans', align: 'center', tx: 0.5, ty: 0.5 }
    case 'arrow':
      return { ...base, kind, x1: 0.34, y1: 0.55, x2: 0.52, y2: 0.4, color: accent(s), width: 9 }
    case 'box':
      return { ...base, kind, x: 0.3, y: 0.3, w: 0.3, h: 0.2, color: accent(s), width: 6, radius: 14, fill: null }
    case 'step': {
      const n = s.project.overlays.filter((o) => o.kind === 'step').length + 1
      return { ...base, kind, x: 0.5, y: 0.4, n, color: accent(s), size: 44 }
    }
    case 'spotlight':
      return { ...base, kind, x: 0.3, y: 0.3, w: 0.4, h: 0.36, shape: 'ellipse', dim: 0.65 }
    case 'blur':
      return { ...base, kind, fade: false, x: 0.3, y: 0.38, w: 0.3, h: 0.14, mode: 'blur', strength: 6 }
    case 'zoom':
      return { ...base, kind, fade: false, x: 0.3, y: 0.3, w: 0.4, h: 0.4, ease: 0.6 }
  }
}

/** The same, as a small window in a corner (a picture-in-picture). */
export function newPipClip(s: Store, m: MediaInfo): Clip {
  return { ...newClipFrom(s, m), box: { x: 0.66, y: 0.06, w: 0.28 }, border: true }
}

export function newClipFrom(s: Store, m: MediaInfo): Clip {
  const frames = (t: number): number => Math.floor(t * s.fps) / s.fps
  return {
    id: newId('c'), kind: m.kind === 'image' ? 'image' : 'video', media: m.id, name: m.name, in: 0, out: m.kind === 'image' ? 5 : Math.max(0.2, frames(m.duration)),
    hasAudio: m.hasAudio, volume: 1, width: m.width, height: m.height, track: '', start: 0, ...newClipBase()
  }
}

export const CARD_STYLES: Array<{ id: string; label: string; make: (s: Store) => TitleCard }> = [
  { id: 'dark', label: 'Dark', make: () => ({ title: 'Your title', subtitle: 'A short line underneath', bg: ['#111827', '#111827'], color: '#ffffff', font: 'sans', align: 'center' }) },
  { id: 'gradient', label: 'Gradient', make: () => ({ title: 'Your title', subtitle: 'A short line underneath', bg: ['#4f46e5', '#9333ea'], color: '#ffffff', font: 'sans', align: 'center' }) },
  { id: 'brand', label: 'Your brand', make: (s) => ({ title: 'Your title', subtitle: 'A short line underneath', bg: [s.brand.colors[0] ?? '#ef4444', s.brand.colors[0] ?? '#ef4444'], color: '#ffffff', font: s.brand.fonts[0]?.name ?? 'sans', align: 'left' }) }
]

export function newCardClip(s: Store, style: (typeof CARD_STYLES)[number]): Clip {
  const size = s.outputSize
  return {
    id: newId('c'), kind: 'image', media: 'card', name: 'Title card', in: 0, out: 3, hasAudio: false, volume: 1, track: '', start: 0, ...newClipBase(),
    width: size.width, height: size.height, card: style.make(s)
  }
}

export const SYSTEM_FONTS: Array<[string, string]> = [
  ['sans', 'Screen Snap'], ['Arial', 'Arial'], ['Verdana', 'Verdana'], ['Trebuchet MS', 'Trebuchet MS'], ['Georgia', 'Georgia'],
  ['Courier New', 'Courier New'], ['Impact', 'Impact']
]
