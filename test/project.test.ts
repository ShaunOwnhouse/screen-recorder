import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cutOverlays, deleteClip, insertClip, isPlain, layout, moveClip, newId, newProject, openGap, overlayAlpha, placedAt, splitAt, totalDuration,
  trimClip, zoomState, type Clip, type Overlay, type Project, type ZoomOverlay
} from '../src/shared/project.ts'

const base = (): Project => newProject({ duration: 20, width: 1920, height: 1080, hasAudio: true })
const text = (start: number, end: number): Overlay => ({ id: newId('o'), kind: 'text', start, end, fade: true, x: 0.1, y: 0.1, w: 0.3, text: 'hi', size: 24, color: '#fff', bg: '', font: 'sans', align: 'left', tx: 0.5, ty: 0.5 })
const times = (p: Project): Array<[number, number]> => p.overlays.map((o) => [o.start, o.end])

test('a fresh project is the recording and nothing else, and counts as untouched', () => {
  const p = base()
  assert.equal(totalDuration(p.clips), 20)
  assert.ok(isPlain(p, 20))
  assert.ok(!isPlain({ ...p, overlays: [text(1, 3)] }, 20))
  assert.ok(!isPlain({ ...p, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }, 20))
  assert.ok(!isPlain({ ...p, clips: [{ ...p.clips[0], out: 10 }] }, 20))
})

test('splitting cuts a clip in two at the playhead, and refuses to cut at an edge', () => {
  const p = base()
  const e = splitAt(p, 8)!
  assert.equal(e.project.clips.length, 2)
  assert.deepEqual(e.project.clips.map((c) => [c.in, c.out]), [[0, 8], [8, 20]])
  assert.equal(totalDuration(e.project.clips), 20)
  assert.equal(splitAt(p, 0.05), null)
  assert.equal(splitAt(p, 19.95), null)
})

test('deleting a piece closes the gap and carries later comments with the video', () => {
  const p = splitAt(splitAt(base(), 5)!.project, 10)!.project // 0-5, 5-10, 10-20
  const withOverlays: Project = { ...p, overlays: [text(1, 3), text(7, 9), text(12, 15), text(4, 7), text(9, 12)] }
  const middle = withOverlays.clips[1].id
  const e = deleteClip(withOverlays, middle)!
  assert.equal(totalDuration(e.project.clips), 15)
  // the comment that sat entirely inside the removed piece is gone; ones after it moved 5 s earlier
  assert.ok(!e.project.overlays.some((o) => o.start === 7 && o.end === 9))
  assert.ok(e.project.overlays.some((o) => o.start === 7 && o.end === 10), 'the one from 12-15 now at 7-10')
  assert.ok(e.project.overlays.some((o) => o.start === 4 && o.end === 5), 'one crossing the start of the cut is trimmed to it')
  assert.ok(e.project.overlays.some((o) => o.start === 5 && o.end === 7), 'one crossing the end of the cut starts where the cut was')
  assert.equal(deleteClip(base(), base().clips[0].id), null, 'the last clip cannot be deleted')
})

test('trimming the end of a clip shortens it and pulls later things earlier; stretching it pushes them later', () => {
  const p = { ...splitAt(base(), 10)!.project, overlays: [text(12, 15)] }
  const first = p.clips[0].id
  const shorter = trimClip(p, first, 'end', 7, 20)!
  assert.equal(totalDuration(shorter.clips), 17)
  assert.deepEqual(times(shorter), [[9, 12]])
  const longer = trimClip(shorter, first, 'end', 9, 20)!
  assert.equal(totalDuration(longer.clips), 19)
  assert.deepEqual(times(longer), [[11, 14]])
  assert.equal(trimClip(p, first, 'end', 99, 20)!.clips[0].out, 20, 'cannot go past the end of the file')
})

test('trimming the start of a clip removes that part of the timeline', () => {
  const p = { ...base(), overlays: [text(1, 3), text(6, 8)] }
  const t = trimClip(p, p.clips[0].id, 'start', 4, 20)!
  assert.equal(t.clips[0].in, 4)
  assert.equal(totalDuration(t.clips), 16)
  assert.deepEqual(times(t), [[2, 4]])
})

test('inserting a clip in the middle splits what is there and pushes later comments out', () => {
  const p = { ...base(), overlays: [text(2, 4), text(12, 14)] }
  const extra: Clip = { ...p.clips[0], id: newId('c'), kind: 'video', media: 'm1', name: 'extra.mp4', in: 0, out: 3 }
  const e = insertClip(p, extra, 8)
  assert.deepEqual(e.project.clips.map((c) => c.media), ['recording', 'm1', 'recording'])
  assert.equal(totalDuration(e.project.clips), 23)
  assert.deepEqual(times(e.project), [[2, 4], [15, 17]])
  assert.equal(e.select, extra.id)
})

test('a fade makes two clips overlap, and the later clip is the one showing during it', () => {
  const [a, b] = splitAt(base(), 10)!.project.clips
  const clips = [a, { ...b, transition: 'fade' as const, transitionDur: 1 }]
  const placed = layout(clips)
  assert.equal(placed[1].start, 9)
  assert.equal(totalDuration(clips), 19)
  assert.equal(placedAt(clips, 9.5)!.clip.id, b.id)
  assert.equal(placedAt(clips, 5)!.clip.id, a.id)
})

test('the first clip never fades in, even after moving or deleting', () => {
  const p = splitAt(splitAt(base(), 5)!.project, 10)!.project
  const faded: Project = { ...p, clips: p.clips.map((c, i) => (i > 0 ? { ...c, transition: 'fade' as const } : c)) }
  assert.equal(moveClip(faded, faded.clips[2].id, 0).clips[0].transition, 'cut')
  assert.equal(deleteClip(faded, faded.clips[0].id)!.project.clips[0].transition, 'cut')
})

test('overlays fade over 0.3 s at each end, and not at all when fading is off', () => {
  const o = text(2, 6)
  assert.equal(overlayAlpha(o, 1.9), 0)
  assert.ok(Math.abs(overlayAlpha(o, 2.15) - 0.5) < 1e-9)
  assert.equal(overlayAlpha(o, 4), 1)
  assert.ok(overlayAlpha(o, 5.9) < 0.5)
  assert.equal(overlayAlpha(o, 6), 0)
  assert.equal(overlayAlpha({ ...o, fade: false }, 2.01), 1)
})

test('zoom glides to the chosen area, holds, and goes back', () => {
  const z: ZoomOverlay = { id: 'z', kind: 'zoom', start: 2, end: 8, fade: false, x: 0, y: 0, w: 0.5, h: 0.5, ease: 1 }
  assert.deepEqual(zoomState([z], 1), { z: 1, cx: 0.5, cy: 0.5 })
  const held = zoomState([z], 5)
  assert.equal(held.z, 2)
  assert.ok(Math.abs(held.cx - 0.25) < 1e-9 && Math.abs(held.cy - 0.25) < 1e-9)
  const mid = zoomState([z], 2.5)
  assert.ok(mid.z > 1 && mid.z < 2)
  assert.deepEqual(zoomState([z], 9), { z: 1, cx: 0.5, cy: 0.5 })
})

test('cutting and opening gaps are exact inverses for things after the gap', () => {
  const o = [text(10, 12)]
  assert.deepEqual(times({ ...base(), overlays: cutOverlays(openGap(o, 5, 3), 5, 8) }), [[10, 12]])
})
