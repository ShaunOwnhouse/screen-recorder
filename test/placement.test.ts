import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awayPlacement, barPlacement, BAR_HEIGHT, BAR_WIDTH, overlaps, type PlaceDisplay } from '../src/main/placement.ts'

// A 1920×1080 main screen with a second 2560×1440 screen to its right (taskbar takes 40 px at the bottom).
const main: PlaceDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
}
const second: PlaceDisplay = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 }
}
const both = [main, second]
const barRect = (p: { x: number; y: number }) => ({ x: p.x, y: p.y, width: BAR_WIDTH, height: BAR_HEIGHT })
const inside = (r: { x: number; y: number; width: number; height: number }, d: PlaceDisplay) =>
  r.x >= d.bounds.x && r.y >= d.bounds.y && r.x + r.width <= d.bounds.x + d.bounds.width && r.y + r.height <= d.bounds.y + d.bounds.height

test('whole second screen: the bar is on THAT screen, not the main one', () => {
  const p = barPlacement(second, second.bounds, both)
  assert.equal(p.displayId, 2)
  assert.ok(inside(barRect(p), second), JSON.stringify(p))
  assert.equal(p.x, Math.round(1920 + (2560 - BAR_WIDTH) / 2))
})

test('whole main screen: the bar is on the main screen', () => {
  const p = barPlacement(main, main.bounds, both)
  assert.equal(p.displayId, 1)
  assert.ok(inside(barRect(p), main))
})

test('single screen, whole screen: the bar stays on it', () => {
  const p = barPlacement(main, main.bounds, [main])
  assert.equal(p.displayId, 1)
})

test('region on the second screen: bar stays on that screen and clear of the region', () => {
  const region = { x: 2000, y: 20, width: 2400, height: 600 } // covers the top of the second screen
  const p = barPlacement(second, region, both)
  assert.equal(p.displayId, 2)
  assert.ok(!overlaps(barRect(p), region), `bar ${JSON.stringify(barRect(p))} vs ${JSON.stringify(region)}`)
  assert.ok(inside(barRect(p), second))
})

test('region that nearly fills a screen: the bar still goes on THAT screen (top centre), never the other one', () => {
  const region = { x: 1925, y: 5, width: 2550, height: 1430 }
  const p = barPlacement(second, region, both)
  assert.equal(p.displayId, 2)
  assert.ok(inside(barRect(p), second), JSON.stringify(p))
  assert.equal(p.x, Math.round(1920 + (2560 - BAR_WIDTH) / 2))
})

test('a big region on the second screen while the app is on the main screen: the timer is on the second screen', () => {
  for (const region of [
    { x: 1940, y: 10, width: 2520, height: 1380 },
    { x: 2000, y: 0, width: 2480, height: 1440 },
    { x: 1920, y: 30, width: 2560, height: 1410 }
  ]) {
    const p = barPlacement(second, region, both)
    assert.equal(p.displayId, 2, JSON.stringify(region))
    assert.ok(inside(barRect(p), second))
  }
})

test('fallback if the bar shows up in the capture: other screen, or none when there is only one', () => {
  assert.equal(awayPlacement(second, both)?.displayId, 1)
  assert.equal(awayPlacement(main, [main]), null)
})
