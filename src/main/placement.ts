import type { Rect } from '../shared/types.ts'

/** The bits of an Electron `Display` that placement needs (kept separate so it can be unit-tested). */
export interface PlaceDisplay {
  id: number
  bounds: Rect
  workArea: Rect
}

export interface Placement {
  displayId: number
  x: number
  y: number
}

export const BAR_WIDTH = 340
export const BAR_HEIGHT = 44
const GAP = 12

export const overlaps = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.width + pad && a.x + a.width + pad > b.x && a.y < b.y + b.height + pad && a.y + a.height + pad > b.y

const topCentre = (d: PlaceDisplay): Placement => ({
  displayId: d.id,
  x: Math.round(d.workArea.x + (d.workArea.width - BAR_WIDTH) / 2),
  y: d.workArea.y + GAP
})

/**
 * Where the timer bar goes: ON THE SCREEN BEING RECORDED, so it is right where the person is looking.
 * Whole screen → top centre of that screen (the capture exclusion hides it from the video; the app also
 * checks that at runtime and moves it away if it ever shows up). Region → the first spot on that screen
 * that doesn't touch the selected area, so it's never in the video at all.
 */
export function barPlacement(home: PlaceDisplay, recorded: Rect, all: PlaceDisplay[]): Placement {
  const whole = recorded.width >= home.bounds.width - 2 && recorded.height >= home.bounds.height - 2
  if (whole) return topCentre(home)

  const a = home.workArea
  const cx = Math.round(a.x + (a.width - BAR_WIDTH) / 2)
  const candidates = [
    { x: cx, y: a.y + GAP },
    { x: cx, y: a.y + a.height - BAR_HEIGHT - GAP },
    { x: a.x + GAP, y: a.y + GAP },
    { x: a.x + a.width - BAR_WIDTH - GAP, y: a.y + GAP },
    { x: a.x + GAP, y: a.y + a.height - BAR_HEIGHT - GAP },
    { x: a.x + a.width - BAR_WIDTH - GAP, y: a.y + a.height - BAR_HEIGHT - GAP }
  ]
  const free = candidates.find((c) => !overlaps({ x: c.x, y: c.y, width: BAR_WIDTH, height: BAR_HEIGHT }, recorded, 8))
  if (free) return { displayId: home.id, ...free }
  // The region fills the screen: the only spot that isn't in the video is another screen.
  const other = all.find((d) => d.id !== home.id)
  return other ? topCentre(other) : { displayId: home.id, ...candidates[0] }
}

/** Fallback if the bar turns out to show up in the capture: another screen, if there is one. */
export function awayPlacement(home: PlaceDisplay, all: PlaceDisplay[]): Placement | null {
  const other = all.find((d) => d.id !== home.id)
  return other ? topCentre(other) : null
}
