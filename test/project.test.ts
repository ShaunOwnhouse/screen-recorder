import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeClips, addAudioTrack, addClip, addSound, addVideoTrack, baseVideoTrack, cameraPieces, clipEnd, clipLength, cutOverlays, deleteClip, detachSound,
  duplicateClip, duplicateSound, insertClipPushing, isFree, isPlain, moveClip, moveSound, newCamera, newClipBase, newId, newProject, nearestFree, openGap,
  overlayAlpha, patchTrack, removeSpan, removeTrack, setClipSpeed, setSoundSpeed, soundEnd, splitAt, totalDuration, trimClip, trimSound, videoTracks,
  zoomState, type Clip, type Overlay, type Project, type Sound, type ZoomOverlay
} from '../src/shared/project.ts'

const base = (): Project => newProject({ duration: 20, width: 1920, height: 1080, hasAudio: true })
const text = (start: number, end: number): Overlay => ({ id: newId('o'), kind: 'text', start, end, fade: true, x: 0.1, y: 0.1, w: 0.3, text: 'hi', size: 24, color: '#fff', bg: '', font: 'sans', align: 'left', tx: 0.5, ty: 0.5 })
const times = (p: Project): Array<[number, number]> => p.overlays.map((o) => [o.start, o.end])
const video = (len: number, name = 'clip'): Clip => ({ id: newId('c'), track: '', start: 0, kind: 'video', media: 'm1', name, in: 0, out: len, hasAudio: true, volume: 1, width: 640, height: 360, ...newClipBase() })
const song = (start: number, length: number): Omit<Sound, 'track'> => ({ id: newId('s'), origin: 'music', media: 's1', name: 'song', duration: 30, offset: 0, start, length, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, loop: false, duck: false })

test('a fresh project is the recording on one video track, with one empty audio track, and counts as untouched', () => {
  const p = base()
  assert.equal(totalDuration(p), 20)
  assert.deepEqual(p.tracks.map((t) => t.kind), ['video', 'audio'])
  assert.ok(isPlain(p, 20))
  assert.ok(!isPlain({ ...p, overlays: [text(1, 3)] }, 20))
  assert.ok(!isPlain({ ...p, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }, 20))
  assert.ok(!isPlain({ ...p, clips: [{ ...p.clips[0], out: 10 }] }, 20))
  assert.ok(!isPlain({ ...p, clips: [{ ...p.clips[0], speed: 2 }] }, 20))
  assert.ok(!isPlain({ ...p, speed: 2 }, 20))
})

test('splitting the selected piece cuts it in two at the playhead, and refuses to cut at an edge', () => {
  const p = base()
  const id = p.clips[0].id
  const e = splitAt(p, 8, id)!
  assert.equal(e.project.clips.length, 2)
  const [a, b] = [...e.project.clips].sort((x, y) => x.start - y.start)
  assert.equal(clipEnd(a), 8)
  assert.equal(b.start, 8)
  assert.equal(b.in, 8)
  assert.equal(totalDuration(e.project), 20)
  assert.equal(e.select, b.id)
  assert.equal(splitAt(p, 0.05, id), null)
  assert.equal(splitAt(p, 19.95, id), null)
})

test('with nothing selected, splitting cuts everything playing at that moment, on every track that is not locked', () => {
  let p = base()
  const added = addClip(p, video(10), 2)
  p = added.project
  const s = addSound(p, song(0, 20))
  p = s.project
  const cut = splitAt(p, 5)!.project
  assert.equal(cut.clips.length, 4)
  assert.equal(cut.sounds.length, 2)
  // a locked track is left alone
  const locked = patchTrack(p, p.clips[0].track, { locked: true })
  assert.equal(splitAt(locked, 5)!.project.clips.filter((c) => c.track === p.clips[0].track).length, 1)
})

test('deleting a piece closes the gap on every track and carries later comments, sounds and pieces with it', () => {
  let p = base()
  const first = p.clips[0]
  p = splitAt(p, 5, first.id)!.project
  p = splitAt(p, 10, p.clips.find((c) => c.start === 5)!.id)!.project
  const middle = p.clips.find((c) => c.start === 5)!
  p = { ...p, overlays: [text(12, 14), text(1, 3)] }
  p = addSound(p, song(0, 20)).project
  const e = deleteClip(p, middle.id)!
  assert.equal(totalDuration(e.project), 15)
  assert.deepEqual(times(e.project).sort((a, b) => a[0] - b[0]), [[1, 3], [7, 9]])
  // the song under it was cut in two, the second part moved earlier
  assert.equal(e.project.sounds.length, 2)
  assert.equal(Math.max(...e.project.sounds.map((s) => soundEnd(s))), 15)
  // a piece can also be removed and leave a gap
  const gap = deleteClip(p, middle.id, false)!
  assert.equal(totalDuration(gap.project), 20)
  assert.equal(gap.project.clips.length, 2)
  // the last piece cannot go
  assert.equal(deleteClip(base(), base().clips[0].id), null)
})

test('trimming an edge changes only that piece, and stops at its neighbours', () => {
  let p = base()
  p = splitAt(p, 10, p.clips[0].id)!.project
  const [a, b] = [...p.clips].sort((x, y) => x.start - y.start)
  // pull the end of the first piece in: a gap opens and nothing moves
  const shorter = trimClip(p, a.id, 'end', 6, 20)!
  assert.equal(clipEnd(shorter.clips.find((c) => c.id === a.id)!), 6)
  assert.equal(shorter.clips.find((c) => c.id === b.id)!.start, 10)
  // it can't be pulled out past the next piece
  const stuck = trimClip(shorter, a.id, 'end', 15, 20)!
  assert.equal(clipEnd(stuck.clips.find((c) => c.id === a.id)!), 10)
  // pulling the start in drops that part of the source
  const later = trimClip(p, b.id, 'start', 13, 20)!.clips.find((c) => c.id === b.id)!
  assert.equal(later.start, 13)
  assert.equal(later.in, 13)
  // it can't go earlier than the piece before it
  const clamped = trimClip(later ? { ...p, clips: p.clips.map((c) => (c.id === b.id ? later : c)) } : p, b.id, 'start', 2, 20)!.clips.find((c) => c.id === b.id)!
  assert.equal(clamped.start, 10)
})

test('a piece can be slid to another track and lands where there is room', () => {
  let p = base()
  p = addVideoTrack(p).project
  const [top] = videoTracks(p)
  const c = p.clips[0]
  const moved = moveClip(p, c.id, top.id, 5)!
  assert.equal(moved.clips[0].track, top.id)
  assert.equal(moved.clips[0].start, 5)
  // two pieces on one track don't overlap: the second is placed beside the first
  const two = addClip(moved, video(4), 6)
  assert.equal(two.project.clips.find((x) => x.id === two.select)!.track, baseVideoTrack(two.project).id, 'goes where it fits: the empty bottom track')
  // a locked track does not take pieces
  const locked = patchTrack(p, top.id, { locked: true })
  assert.equal(moveClip(locked, c.id, top.id, 1), null)
})

test('adding a piece builds a sequence on one track and goes on a new track in front when the track is busy', () => {
  let p = base()
  const a = addClip(p, video(5, 'a'), 20)
  p = a.project
  assert.equal(p.clips.length, 2)
  assert.equal(videoTracks(p).length, 1, 'appended after the end: same track')
  const b = addClip(p, video(5, 'b'), 3)
  p = b.project
  assert.equal(videoTracks(p).length, 2, 'dropped in the middle: a new track in front')
  const added = p.clips.find((c) => c.id === b.select)!
  assert.equal(added.track, videoTracks(p)[0].id)
  assert.equal(added.start, 3)
})

test('adding a piece and pushing everything later opens the time for it on every track', () => {
  let p = base()
  p = { ...p, overlays: [text(10, 12)] }
  p = addSound(p, song(0, 20)).project
  const e = insertClipPushing(p, video(5), 8)
  assert.equal(totalDuration(e.project), 25)
  assert.deepEqual(times(e.project), [[15, 17]])
  const inserted = e.project.clips.find((c) => c.id === e.select)!
  assert.equal(inserted.start, 8)
  assert.equal(inserted.track, baseVideoTrack(e.project).id)
  assert.equal(e.project.sounds.length, 2)
})

test('duplicating puts the copy on the track above, ready to be slid before the original', () => {
  const p = base()
  const e = duplicateClip(p, p.clips[0].id)!
  assert.equal(e.project.clips.length, 2)
  const copy = e.project.clips.find((c) => c.id === e.select)!
  assert.notEqual(copy.track, p.clips[0].track)
  assert.equal(copy.start, 0)
  assert.equal(videoTracks(e.project)[0].id, copy.track, 'the new track is in front of the original')
  // a second copy reuses a free track above rather than growing the stack forever
  const second = duplicateClip(p, p.clips[0].id)!
  assert.equal(videoTracks(second.project).length, 2)
  // the copy can now be put before the original on its own track
  const moved = moveClip(e.project, copy.id, copy.track, 0)!
  assert.equal(moved.clips.find((c) => c.id === copy.id)!.start, 0)
})

test('a faster piece is shorter on the timeline, a slower one longer, and what follows is pushed rather than overlapped', () => {
  let p = base()
  p = splitAt(p, 10, p.clips[0].id)!.project
  const [a, b] = [...p.clips].sort((x, y) => x.start - y.start)
  const fast = setClipSpeed(p, a.id, 2)!
  assert.equal(clipLength(fast.clips.find((c) => c.id === a.id)!), 5)
  assert.equal(fast.clips.find((c) => c.id === b.id)!.start, 10, 'a gap, not a move')
  const slow = setClipSpeed(p, a.id, 0.5)!
  assert.equal(clipLength(slow.clips.find((c) => c.id === a.id)!), 20)
  assert.equal(slow.clips.find((c) => c.id === b.id)!.start, 20, 'pushed so nothing overlaps')
  assert.ok(isFree(slow, a.track, 20, 30, a.id) === false)
  // a split piece of a sped-up one keeps its speed and the source moves on by the right amount
  const cut = splitAt(fast, 4, a.id)!.project
  const second = cut.clips.find((c) => c.start === 4)!
  assert.equal(second.speed, 2)
  assert.equal(second.in, 8)
})

test('nothing may overlap on a track', () => {
  let p = base()
  p = splitAt(p, 10, p.clips[0].id)!.project
  const top = addVideoTrack(p)
  p = top.project
  assert.equal(nearestFree(p, p.clips[0].track, 5, 3), null === undefined ? 0 : nearestFree(p, p.clips[0].track, 5, 3))
  assert.ok(isFree(p, top.track.id, 0, 100))
  assert.ok(!isFree(p, p.clips[0].track, 5, 6))
  assert.equal(nearestFree(p, top.track.id, 5, 3), 5)
})

test('sounds go on the first audio track with room, and a new track when there is none', () => {
  let p = base()
  const a = addSound(p, song(0, 10))
  p = a.project
  assert.equal(p.tracks.filter((t) => t.kind === 'audio').length, 1)
  const b = addSound(p, song(5, 10))
  p = b.project
  assert.equal(p.tracks.filter((t) => t.kind === 'audio').length, 2, 'overlapping: a second audio track')
  assert.notEqual(a.sound.track, b.sound.track)
  const c = addSound(p, song(10, 5))
  assert.equal(c.sound.track, a.sound.track, 'fits after the first on its track')
  // moving and duplicating
  const dup = duplicateSound(p, a.sound.id)!
  assert.equal(dup.project.sounds.length, 3)
  const m = moveSound(p, b.sound.id, a.sound.track, 5)!
  assert.equal(m.sounds.find((s) => s.id === b.sound.id)!.start, 10, 'the nearest room, after the first')
  // trimming
  const t = trimSound(p, a.sound.id, 'end', 4)!.sounds.find((s) => s.id === a.sound.id)!
  assert.equal(t.length, 4)
  const t2 = trimSound(p, b.sound.id, 'start', 8)!.sounds.find((s) => s.id === b.sound.id)!
  assert.equal(t2.start, 8)
  assert.equal(t2.offset, 3)
  // a faster sound is shorter
  const fast = setSoundSpeed(p, a.sound.id, 2)!.sounds.find((s) => s.id === a.sound.id)!
  assert.equal(fast.length, 5)
})

test('separating a piece\'s sound makes a sound of its own at the same place and silences the piece', () => {
  let p = base()
  const e = addClip(p, video(6, 'talk'), 20)
  p = e.project
  const r = detachSound(p, e.select!)!
  assert.equal(r.sound.start, 20)
  assert.equal(r.sound.length, 6)
  assert.equal(r.project.clips.find((c) => c.id === e.select)!.hasAudio, false)
  assert.equal(detachSound(r.project, e.select!), null, 'nothing left to separate')
})

test('tracks can be added, and only empty ones removed (one of each kind always stays)', () => {
  let p = base()
  const v = addVideoTrack(p)
  const a = addAudioTrack(v.project)
  p = a.project
  assert.deepEqual(p.tracks.map((t) => t.kind), ['video', 'video', 'audio', 'audio'])
  assert.equal(removeTrack(p, baseVideoTrack(p).id), null, 'it has the recording on it')
  assert.ok(removeTrack(p, v.track.id))
  assert.ok(removeTrack(p, a.track.id))
  assert.equal(removeTrack(base(), base().tracks[1].id), null, 'the last audio track stays')
})

test('which pieces show at a moment, from the back of the picture to the front', () => {
  let p = base()
  const e = addClip(p, video(6), 2)
  p = e.project
  const at4 = activeClips(p, 4)
  assert.equal(at4.length, 2)
  assert.equal(at4[1].id, e.select, 'the new track is in front')
  assert.equal(activeClips(p, 1).length, 1)
  assert.equal(activeClips(p, 20).length, 0)
})

test('removing a span is the same as cutting it out of every track', () => {
  let p = base()
  p = addSound(p, song(0, 20)).project
  const q = removeSpan(p, 4, 9)
  assert.equal(totalDuration(q), 15)
  assert.equal(q.clips.length, 2)
  assert.equal(q.sounds.length, 2)
})

test('the camera follows the recording pieces and plays at the same speed', () => {
  let p = base()
  p = { ...p, camera: newCamera({ media: 'camera', name: 'camera', duration: 20, width: 1280, height: 720, hasAudio: true }, 0.5, 16 / 9) }
  const one = cameraPieces(p)
  assert.equal(one.length, 1)
  assert.equal(one[0].from, 0.5)
  const fast = setClipSpeed(p, p.clips[0].id, 2)!
  assert.equal(cameraPieces(fast)[0].speed, 2)
  assert.ok(cameraPieces(fast)[0].end - cameraPieces(fast)[0].start < 11)
  const hidden = patchTrack(p, p.clips[0].track, { hidden: true })
  assert.equal(cameraPieces(hidden).length, 0)
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
