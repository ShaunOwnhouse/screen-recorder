'use strict'
// The editor, used the way a person uses it: cut, comment, shapes, extra video/picture, music, title card, brand, crop, save.
// Called from run.cjs with a freshly recorded video open in the review window.
const fs = require('node:fs')
const path = require('node:path')

async function editorSuite(c) {
  const { app, editor, main, check, warn, log, sleep, userData, ff, FFMPEG, save, validate, seekTo, editorState, answerPicker, pixelAt, nearColour, cutFirstThird, isWin, shot } = c
  const state = () => editorState(editor)
  const store = (fn, arg) => editor.evaluate(fn, arg)
  const tag = 'Editor'
  const approx = (a, b, tol) => Math.abs(a - b) <= tol
  /** Opens a folded section of the settings panel (they start closed to keep the panel short). */
  const openFold = async (id) => {
    const head = editor.locator(`#${id}-fold`)
    await head.waitFor({ timeout: 5000 })
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  }

  // ---- media to add ----
  const media = path.join(userData, 'extra-media')
  fs.mkdirSync(media, { recursive: true })
  const clip = path.join(media, 'blue clip.mp4')
  const pic = path.join(media, 'logo.png')
  const song = path.join(media, 'song.wav')
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x2040e0:s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '3', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-c:a', 'aac', clip])
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xe0c020:s=300x300', '-frames:v', '1', pic])
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100,volume=6', '-t', '5', song])

  // ---- the layout fits the window, on a big monitor and on a small one ----
  const fit = () => editor.evaluate(() => {
    const el = (q) => document.querySelector(q)
    const foot = el('footer.save').getBoundingClientRect()
    const tl = el('#timeline').getBoundingClientRect()
    const stage = el('#stage').getBoundingClientRect()
    const below = parseFloat(getComputedStyle(el('.editor')).getPropertyValue('--below')) || 0
    const chrome = window.outerHeight - window.innerHeight
    return {
      innerH: innerHeight, innerW: innerWidth, below, footBottom: Math.round(foot.bottom), saveBtn: Math.round(el('#save').getBoundingClientRect().bottom),
      stageH: Math.round(stage.height), tlH: Math.round(tl.height), docH: document.documentElement.scrollHeight,
      // where the bottom of the save row really is on the screen
      onScreen: Math.round(window.screenY + chrome + foot.bottom), availH: screen.availHeight
    }
  })
  const winOf = `BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Review recording')`
  const orig = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Review recording')?.getBounds())
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const place = async (b) => {
    await app.evaluate(({ BrowserWindow }, bb) => {
      const win = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Review recording')
      if (win) { win.setMinimumSize(300, 300); win.setBounds(bb) }
    }, b)
    await sleep(1300)
  }
  void winOf
  // sizes that fit the screen, and sizes bigger than it (a big window on a small screen is the same as a window hanging below)
  for (const [w, h] of [[1920, 1040], [1366, 728], [1100, 640], [1100, 580]]) {
    await place({ x: 0, y: 0, width: w, height: h })
    const f = await fit()
    if (w === 1366) await shot(editor, `editor-${w}x${h}`)
    check(`${tag}: a ${w}×${h} window keeps its whole save row in view (nothing pushed below the screen)`, f.saveBtn <= f.innerH - f.below + 1 && f.docH <= f.innerH + 1 && f.onScreen <= f.availH + 14, JSON.stringify(f))
  }
  // a window hanging below the usable screen (under the taskbar) is told so and keeps its save row in view
  await place({ x: 0, y: Math.max(0, workArea.height - 640), width: 1500, height: 900 })
  const hang = await fit()
  check(`${tag}: a window hanging below the screen is told so, and its save row stays on screen`, hang.below > 100 && hang.onScreen <= hang.availH + 14, JSON.stringify(hang))
  await place(orig)

  // ---- windows over the editor cover all of it; the timeline and the file-name area fold away ----
  {
    // nothing of the editor (selected bars, the selection box, the playhead, the camera window) may show over the preview or the saving window
    const covered = await editor.evaluate(() => {
      const st = window.__editor.store
      if (st.project.clips[0]) st.select({ kind: 'clip', id: st.project.clips[0].id })
      const out = {}
      for (const id of ['busy', 'pv']) {
        const el = document.getElementById(id)
        if (!el) continue
        const wasHidden = el.hidden
        el.hidden = false
        const spots = [['tl', '#timeline'], ['head', '.tl-head'], ['stage', '#stage'], ['sel', '.blk.sel']]
        out[id] = spots.map(([n, q]) => {
          const t = document.querySelector(q)
          if (!t) return [n, 'absent']
          const r = t.getBoundingClientRect()
          const top = document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + Math.min(20, r.height / 2))
          return [n, !!top && el.contains(top)]
        })
        el.hidden = wasHidden
      }
      st.select(null)
      return out
    })
    const bad = Object.entries(covered).flatMap(([id, list]) => list.filter(([, v]) => v === false).map(([n]) => `${id}:${n}`))
    check(`${tag}: the preview and the saving window cover the whole editor (no bar, box or playhead shows over them)`, bad.length === 0, JSON.stringify(covered))
    // fold away the timeline: more room for the picture, and back
    const stageH = () => editor.evaluate(() => Math.round(document.getElementById('stage').getBoundingClientRect().height))
    const h0 = await stageH()
    await editor.click('#tl-fold')
    await sleep(300)
    const h1 = await stageH()
    check(`${tag}: the Timeline can be folded away, giving the picture more room`, h1 > h0 + 60 && !(await editor.isVisible('#timeline')) && (await editor.isVisible('#split')) && (await editor.getAttribute('#tl-fold', 'aria-expanded')) === 'false', `${h0} → ${h1}`)
    await editor.click('#tl-fold')
    await sleep(300)
    check(`${tag}: and opened again`, (await editor.isVisible('#timeline')) && Math.abs((await stageH()) - h0) < 12, `${await stageH()} vs ${h0}`)
    // fold away the file-name area: the Save buttons stay
    const h2 = await stageH()
    await editor.click('#save-fold')
    await sleep(300)
    const h3 = await stageH()
    check(`${tag}: the File name area can be folded away; Save stays at hand`, h3 > h2 + 30 && !(await editor.isVisible('#name')) && (await editor.isVisible('#save')) && (await editor.isVisible('#save-as')) && /\.mp4$/.test((await editor.textContent('#save-summary')) ?? ''), `${h2} → ${h3} · ${await editor.textContent('#save-summary')}`)
    await editor.click('#save-fold')
    await sleep(300)
    check(`${tag}: and opened again (the file name is there)`, (await editor.isVisible('#name')) && (await editor.isVisible('#format')), `${await stageH()}`)
    // both folded: the picture gets almost all of the window
    await editor.click('#tl-fold')
    await editor.click('#save-fold')
    await sleep(300)
    await shot(editor, 'editor-folded')
    check(`${tag}: with both folded the picture is much bigger, and Save, Split and Undo are still at hand`, (await stageH()) > h0 + 150 && (await editor.isVisible('#save')) && (await editor.isVisible('#split')) && (await editor.isVisible('#undo')), `${await stageH()} vs ${h0}`)
    await editor.click('#tl-fold')
    await editor.click('#save-fold')
    await sleep(300)
  }

  // ---- the screen ----
  check(`${tag}: has the seven tools on the left`, (await editor.locator('.rail-btn').count()) === 7, (await editor.locator('.rail-btn').allTextContents()).join(', '))
  check(`${tag}: the timeline has Video, Comments and Audio rows`, /Video/.test(await editor.textContent('#label-video')) && /Comments/.test(await editor.textContent('#label-over')) && /Audio/.test(await editor.textContent('#label-music')))
  check(`${tag}: the preview shows the picture`, (await editor.locator('#layers video').count()) >= 1 && (await editor.locator('#frame').boundingBox()).width > 100)
  const start = await state()

  // ---- cutting ----
  await cutFirstThird(editor)
  let s = await state()
  check(`${tag}: cutting the first third leaves one shorter piece`, s.clips.length === 1 && s.clips[0].in > 0 && approx(s.duration, start.duration * 0.7, 0.35), `${s.duration.toFixed(2)}s of ${start.duration.toFixed(2)}s`)
  await editor.click('#undo')
  s = await state()
  check(`${tag}: Undo brings the cut part back`, s.clips.length === 2 && approx(s.duration, start.duration, 0.05), `${s.clips.length} pieces`)
  await editor.click('#redo')
  s = await state()
  check(`${tag}: Redo cuts it again`, s.clips.length === 1 && approx(s.duration, start.duration * 0.7, 0.35))
  await seekTo(editor, s.duration * 0.5)
  await editor.keyboard.press('s')
  check(`${tag}: the S key splits at the playhead`, (await state()).clips.length === 2)
  await editor.keyboard.press('Control+z')
  check(`${tag}: Ctrl+Z undoes it`, (await state()).clips.length === 1)

  // dragging the end of a piece trims it and pulls everything later up
  const before = await state()
  const edge = await editor.locator('.blk.clip .edge.r').first().boundingBox()
  await editor.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await editor.mouse.down()
  await editor.mouse.move(edge.x - 70, edge.y + edge.height / 2, { steps: 8 })
  await editor.mouse.up()
  s = await state()
  const px = await store(() => window.__editor.store.pxPerSec)
  check(`${tag}: dragging the end of a piece trims it`, approx(before.duration - s.duration, 70 / px, 0.3), `${(before.duration - s.duration).toFixed(2)}s shorter (expected ${(70 / px).toFixed(2)}s)`)
  await editor.click('#undo')
  s = await state()
  const D = s.duration

  // ---- colour look: presets, sliders, the preview follows, undo, reset ----
  {
    const clipId = (await state()).clips[0].id
    await editor.click(`.blk.clip[data-clip="${clipId}"]`)
    await editor.waitForSelector('#look-fold', { timeout: 5000 })
    check(`${tag}: the Look and Freeze frame sections start folded away, to keep the panel short`, (await editor.getAttribute('#look-fold', 'aria-expanded')) === 'false' && (await editor.getAttribute('#freeze-fold', 'aria-expanded')) === 'false' && !(await editor.isVisible('#look-presets')), '')
    check(`${tag}: a folded section still says its state on its title line`, /Original/.test(await editor.textContent('#look-fold')) && /2 s/.test(await editor.textContent('#freeze-fold')), (await editor.textContent('#look-fold')).trim())
    await openFold('look')
    check(`${tag}: clicking the title opens the section`, await editor.isVisible('#look-presets'))
    const lookOf = () => store((id) => window.__editor.store.project.clips.find((k) => k.id === id)?.look ?? null, clipId)
    check(`${tag}: a piece has a Look section with ready-made looks and four sliders`, (await editor.locator('#look-presets .look').count()) === 6 && (await editor.locator('#look-section input[type=range]').count()) === 4)
    check(`${tag}: a piece starts with no look, and "Original" is the one chosen`, (await lookOf()) === null && (await editor.locator('#look-presets .look.on').getAttribute('data-look')) === 'original')
    await editor.click('#look-presets [data-look="bw"]')
    check(`${tag}: the title line follows the chosen look`, /Black & white/.test(await editor.textContent('#look-fold')), (await editor.textContent('#look-fold')).trim())
    let look = await lookOf()
    check(`${tag}: Black & white takes the colour out`, !!look && look.saturation === 0, JSON.stringify(look))
    check(`${tag}: the chosen look is highlighted`, (await editor.locator('#look-presets .look.on').getAttribute('data-look')) === 'bw')
    await sleep(500)
    const shown = await editor.evaluate((id) => {
      const el = document.querySelector(`#layers [data-layer="${id}"]`)
      const f = document.getElementById(`look-${id}`)
      return { filter: el?.style.filter ?? '', values: f?.querySelector('feColorMatrix')?.getAttribute('values') ?? '' }
    }, clipId)
    check(`${tag}: the preview shows it (a colour filter on the picture)`, shown.filter.includes(`look-${clipId}`) && shown.values.split(/\s+/).length === 20, JSON.stringify(shown))
    // a slider changes one value and moves the chosen look off the presets
    await editor.evaluate(() => {
      const i = document.getElementById('look-brightness')
      i.value = '0.2'
      i.dispatchEvent(new Event('input', { bubbles: true }))
    })
    look = await lookOf()
    check(`${tag}: the brightness slider changes the look`, !!look && Math.abs(look.brightness - 0.2) < 0.01 && look.saturation === 0, JSON.stringify(look))
    check(`${tag}: after a slider no preset is highlighted`, (await editor.locator('#look-presets .look.on').count()) === 0)
    await editor.click('#undo')
    look = await lookOf()
    check(`${tag}: Undo takes the slider change back`, !!look && look.brightness === 0 && look.saturation === 0, JSON.stringify(look))
    check(`${tag}: after a slider the title line says Custom`, /Custom/.test(await editor.textContent('#look-fold')))
    await editor.click('#look-reset')
    check(`${tag}: Reset look puts the colours back as recorded`, (await lookOf()) === null && (await editor.locator('#look-presets .look.on').getAttribute('data-look')) === 'original')
    await sleep(300)
    check(`${tag}: and the preview filter is gone`, (await editor.evaluate((id) => document.querySelector(`#layers [data-layer="${id}"]`)?.style.filter ?? 'x', clipId)) === '')
    // the open section stays open when the panel is rebuilt (another piece picked, then this one again)
    await editor.click('#undo').catch(() => undefined)
    await store(() => window.__editor.store.select(null))
    await store((id) => window.__editor.store.select({ kind: 'clip', id }), clipId)
    await editor.waitForSelector('#look-fold', { timeout: 5000 })
    check(`${tag}: a section left open stays open when the panel is rebuilt`, (await editor.getAttribute('#look-fold', 'aria-expanded')) === 'true' && (await editor.isVisible('#look-presets')))
    await editor.click('#look-fold')
    check(`${tag}: clicking the title again folds it away`, !(await editor.isVisible('#look-presets')))
  }

  // ---- freeze frame: hold the picture at the playhead ----
  {
    const before = await state()
    const freezeShape = (after, at, secs) => {
      const clips = [...after.clips].sort((a, b) => a.start - b.start)
      const still = clips[1]
      return {
        clips,
        still,
        ok: clips.length === before.clips.length + 2 && clips.map((k) => k.kind).join() === 'recording,image,recording' && !!still && approx(still.start, at, 0.1) && approx(still.out - still.in, secs, 0.01) && approx(after.duration, before.duration + secs, 0.2),
        text: `${clips.map((k) => `${k.kind}@${k.start.toFixed(2)}`).join(' ')}; ${before.duration.toFixed(2)} → ${after.duration.toFixed(2)}`
      }
    }
    // with nothing selected: the toolbar button freezes the piece that is playing at the playhead
    await seekTo(editor, before.duration * 0.4)
    const at = await store(() => window.__editor.store.playhead)
    check(`${tag}: nothing is selected after clicking the timeline`, (await store(() => window.__editor.store.selection)) === null)
    await editor.click('#freeze')
    await editor.waitForFunction((n) => window.__editor.store.project.clips.length === n, before.clips.length + 2, { timeout: 15000 }).catch(() => undefined)
    let after = await state()
    let f = freezeShape(after, at, 2)
    check(`${tag}: Freeze frame cuts the piece and puts a 2 second still between the halves, everything after moves later`, f.ok, f.text)
    check(`${tag}: the picture of the held moment was kept with the recording's files`, fs.readdirSync(path.join(userData, 'pending')).filter((n) => /\.media$/.test(n)).some((d) => fs.readdirSync(path.join(userData, 'pending', d)).some((n) => /^freeze-.*\.png$/.test(n))))
    await seekTo(editor, (f.still?.start ?? at) + 1)
    await sleep(500)
    check(`${tag}: the preview shows the still while it is held`, (await editor.locator('#layers img').count()) >= 1)
    check(`${tag}: the still is a piece of its own on the timeline`, !!f.still && (await editor.locator(`.blk.clip[data-clip="${f.still.id}"]`).count()) === 1)
    await editor.click('#undo')
    let back = await state()
    check(`${tag}: Undo takes the freeze frame away`, back.clips.length === before.clips.length && approx(back.duration, before.duration, 0.05), `${back.clips.length} pieces, ${back.duration.toFixed(2)}s`)
    // from the piece's own settings, with a longer hold
    await seekTo(editor, before.duration * 0.4)
    await editor.click(`.blk.clip[data-clip="${before.clips[0].id}"]`)
    await openFold('freeze')
    await editor.waitForSelector('#prop-freeze', { timeout: 5000 })
    await editor.evaluate(() => {
      const i = document.getElementById('freeze-hold')
      i.value = '4'
      i.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await editor.click('#prop-freeze')
    await editor.waitForFunction((n) => window.__editor.store.project.clips.length === n, before.clips.length + 2, { timeout: 15000 }).catch(() => undefined)
    after = await state()
    f = freezeShape(after, at, 4)
    check(`${tag}: from a piece's settings the hold can be longer (4 s)`, f.ok, f.text)
    await editor.click('#undo')
    back = await state()
    check(`${tag}: and that can be undone too`, back.clips.length === before.clips.length && approx(back.duration, before.duration, 0.05))
    await editor.evaluate(() => {
      document.getElementById('freeze-hold') && (document.getElementById('freeze-hold').value = '2')
    })
  }

  // ---- a comment ----
  await seekTo(editor, D * 0.15)
  await editor.click('#tool-comments')
  await editor.click('#add-comment')
  await editor.fill('#prop-text', 'This is where you open Settings')
  s = await state()
  const bubble = s.overlays[0]
  check(`${tag}: Add a comment puts a speech bubble at the playhead`, s.overlays.length === 1 && bubble.kind === 'bubble' && approx(bubble.start, s.playhead, 0.4), `${bubble?.kind} from ${bubble?.start?.toFixed(2)}s`)
  check(`${tag}: its words can be typed in the side panel`, bubble.text === 'This is where you open Settings')
  check(`${tag}: it appears in the Comments row of the timeline`, /This is where/.test(await editor.locator('.blk.over').first().textContent()))
  check(`${tag}: it has a selection box on the video`, await editor.isVisible('#sel'))
  const fb = await editor.locator('#frame').boundingBox()
  const sb = await editor.locator('#sel').boundingBox()
  await editor.mouse.move(sb.x + sb.width * 0.3, sb.y + sb.height * 0.6)
  await editor.mouse.down()
  await editor.mouse.move(sb.x + sb.width * 0.3 + fb.width * 0.1, sb.y + sb.height * 0.6 + fb.height * 0.05, { steps: 8 })
  await editor.mouse.up()
  let moved = (await state()).overlays[0]
  check(`${tag}: dragging it on the video moves it`, approx(moved.x - bubble.x, 0.1, 0.03) && approx(moved.y - bubble.y, 0.05, 0.03), `x ${bubble.x.toFixed(2)}→${moved.x.toFixed(2)}, y ${bubble.y.toFixed(2)}→${moved.y.toFixed(2)}`)
  check(`${tag}: its pointer moved with it`, approx(moved.tx - bubble.tx, 0.1, 0.03))
  const grip = await editor.locator('#sel i.edge-e').boundingBox()
  await editor.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await editor.mouse.down()
  await editor.mouse.move(grip.x + grip.width / 2 + fb.width * 0.08, grip.y + grip.height / 2, { steps: 6 })
  await editor.mouse.up()
  const wider = (await state()).overlays[0]
  check(`${tag}: the handle on its side makes it wider`, wider.w > moved.w + 0.04, `${moved.w.toFixed(2)}→${wider.w.toFixed(2)}`)
  await editor.click('#prop-style .swatch[data-color="#fde047"]')
  await editor.locator('#prop-size').fill('46')
  await editor.locator('#prop-from').fill('0.5')
  await editor.locator('#prop-from').press('Tab')
  s = await state()
  check(`${tag}: colour, size and start time can be changed`, s.overlays[0].bg === '#fde047' && s.overlays[0].size === 46 && approx(s.overlays[0].start, 0.5, 0.06), `${s.overlays[0].bg} ${s.overlays[0].size} ${s.overlays[0].start}`)
  await editor.uncheck('#prop-fade')
  check(`${tag}: fading in and out can be switched off`, (await state()).overlays[0].fade === false)
  await editor.check('#prop-fade')
  await editor.click('#prop-duplicate')
  check(`${tag}: Duplicate makes a second one`, (await state()).overlays.length === 2)
  await editor.click('#prop-delete')
  check(`${tag}: Delete removes it`, (await state()).overlays.length === 1)
  // pick the first one again from the timeline
  await editor.click('.blk.over >> nth=0')
  check(`${tag}: clicking it on the timeline selects it`, (await state()).selection?.kind === 'overlay')
  // move and stretch it on the timeline
  const pxs = await store(() => window.__editor.store.pxPerSec)
  const first = (await state()).overlays[0]
  await editor.locator('#prop-to').fill(String(+(first.start + 2).toFixed(2)))
  await editor.locator('#prop-to').press('Tab')
  const t0 = (await state()).overlays[0]
  check(`${tag}: the end time can be typed in too`, approx(t0.end - t0.start, 2, 0.1), `${t0.start.toFixed(2)}→${t0.end.toFixed(2)}`)
  const blk = await editor.locator('.blk.over').first().boundingBox()
  await editor.mouse.move(blk.x + blk.width / 2, blk.y + blk.height / 2)
  await editor.mouse.down()
  await editor.mouse.move(blk.x + blk.width / 2 + 60, blk.y + blk.height / 2, { steps: 6 })
  await editor.mouse.up()
  const t1 = (await state()).overlays[0]
  check(`${tag}: dragging a comment along the timeline moves when it is shown`, approx(t1.start - t0.start, 60 / pxs, 0.15) && approx(t1.end - t0.end, 60 / pxs, 0.15), `${t0.start.toFixed(2)}→${t1.start.toFixed(2)}`)
  const redge = await editor.locator('.blk.over .edge.r').first().boundingBox()
  await editor.mouse.move(redge.x + redge.width / 2, redge.y + redge.height / 2)
  await editor.mouse.down()
  await editor.mouse.move(redge.x + redge.width / 2 + 40, redge.y + redge.height / 2, { steps: 6 })
  await editor.mouse.up()
  const t2 = (await state()).overlays[0]
  check(`${tag}: dragging its end makes it last longer`, t2.end - t1.end > 0.4 && approx(t2.start, t1.start, 0.05), `${t1.end.toFixed(2)}→${t2.end.toFixed(2)}`)

  // ---- shapes, spotlight, blur, zoom ----
  await editor.click('#tool-shapes')
  for (const id of ['add-arrow', 'add-box', 'add-step', 'add-spotlight', 'add-blur', 'add-zoom']) await editor.click(`#${id}`)
  s = await state()
  check(`${tag}: arrow, box, step, spotlight, blur and zoom can all be added`, ['arrow', 'box', 'step', 'spotlight', 'blur', 'zoom'].every((k) => s.overlays.some((o) => o.kind === k)), s.overlays.map((o) => o.kind).join(','))
  check(`${tag}: a zoom area has handles on all sides`, (await editor.locator('#sel i.h').count()) === 8)
  const lanes = await editor.locator('.blk.over').count()
  check(`${tag}: everything shows in the timeline`, lanes === 7, `${lanes} bars`)
  // arrange the scene: comment-ish things early, the spotlight/blur/zoom later
  await store(([D]) => {
    const st = window.__editor.store
    const early = [0.05 * D, 0.6 * D]
    const late = [0.65 * D, 0.95 * D]
    st.edit((p) => ({ ...p, overlays: p.overlays.map((o) => {
      const [a, b] = ['spotlight', 'blur', 'zoom'].includes(o.kind) ? late : early
      return { ...o, start: Math.round(a * 30) / 30, end: Math.round(b * 30) / 30 }
    }) }))
  }, [D])
  await editor.evaluate(() => window.__editor.store.select(null))
  await seekTo(editor, D * 0.8)
  await sleep(500)
  const zoomed = await editor.$eval('#layers', (e) => e.style.transform)
  check(`${tag}: while a zoom is on, the picture is magnified`, /scale\(/.test(zoomed), zoomed)
  check(`${tag}: blur areas are shown on the video`, (await editor.locator('.blur-box:visible').count()) >= 1)

  // ---- other video, pictures, picture-in-picture ----
  await editor.click('#tool-media')
  await answerPicker(app, [clip])
  await seekTo(editor, D * 0.5)
  const durBefore = (await state()).duration
  await editor.click('#add-media')
  await editor.waitForFunction(() => window.__editor.store.project.clips.some((c) => c.media !== 'recording'), null, { timeout: 15000 })
  s = await state()
  const added = s.clips.find((k) => k.name === 'blue clip.mp4')
  const recTrack = s.clips.find((k) => k.name === 'Recording')?.track
  check(`${tag}: a video added in the middle goes on a new row in front, at the playhead`, !!added && added.track !== recTrack && approx(added.start, D * 0.5, 0.2) && (await editor.locator('.tl-track.video').count()) === 2, `${added?.start}s, ${(await editor.locator('.tl-track.video').count())} video rows`)
  check(`${tag}: and the recording under it is untouched`, approx(s.clips.filter((k) => k.name === 'Recording').reduce((m, k) => m + (k.out - k.in), 0), durBefore, 0.2))
  // fade in from a colour, and out to another
  await editor.locator('#prop-fade-in-dur').fill('1')
  await editor.selectOption('#prop-fade-in-colour', 'dissolve')
  await editor.locator('#prop-fade-out-dur').fill('0.8')
  await editor.selectOption('#prop-fade-out-colour', '#ffffff')
  s = await state()
  const faded = s.clips.find((k) => k.name === 'blue clip.mp4')
  check(`${tag}: a piece can fade in (see-through) and out (to white)`, approx(faded.fadeIn.dur, 1, 0.01) && faded.fadeIn.color === 'dissolve' && approx(faded.fadeOut.dur, 0.8, 0.01) && faded.fadeOut.color === '#ffffff', JSON.stringify([faded.fadeIn, faded.fadeOut]))
  // speed of one piece
  await editor.locator('#prop-speed').fill('2')
  s = await state()
  const fastClip = s.clips.find((k) => k.name === 'blue clip.mp4')
  check(`${tag}: a single piece can be sped up (it gets shorter on the timeline)`, approx(fastClip.speed, 2, 0.01) && approx((fastClip.out - fastClip.in) / fastClip.speed, 1.5, 0.05), `${fastClip.speed}×`)
  // duplicating puts the copy on its own row, so it can be slid before the original
  await editor.click('#prop-clip-duplicate')
  s = await state()
  const copies = s.clips.filter((k) => k.name === 'blue clip.mp4')
  check(`${tag}: a copy goes on a row of its own, above`, copies.length === 2 && copies[0].track !== copies[1].track, copies.map((k) => k.track).join(' / '))
  await editor.click('#undo')
  await editor.click('.blk.clip >> nth=0')
  await answerPicker(app, [pic])
  await editor.click('#add-media')
  await editor.waitForFunction(() => window.__editor.store.project.clips.some((c) => c.kind === 'image'), null, { timeout: 15000 })
  s = await state()
  const still = s.clips.find((k) => k.kind === 'image')
  check(`${tag}: a picture can be added and is shown for 5 seconds`, !!still && approx(still.out - still.in, 5, 0.05))
  await answerPicker(app, [clip])
  await editor.click('#add-pip')
  await editor.waitForFunction(() => window.__editor.store.project.clips.some((c) => c.box.w < 0.99), null, { timeout: 15000 })
  await sleep(500)
  check(`${tag}: a video can be shown in a small window (picture-in-picture)`, (await editor.locator('#layers video:visible').count()) >= 1 && (await editor.isVisible('#sel')))
  // the "+" buttons add rows
  const vRows = await editor.locator('.tl-track.video').count()
  await editor.click('#add-video-track')
  const aRows = await editor.locator('.tl-track.audio').count()
  await editor.click('#add-audio-track')
  check(`${tag}: the "+" buttons add a video row and an audio row`, (await editor.locator('.tl-track.video').count()) === vRows + 1 && (await editor.locator('.tl-track.audio').count()) === aRows + 1)
  // mute / hide / lock buttons on a row
  await editor.click('#label-video [data-act="lock"]')
  check(`${tag}: a row can be locked`, (await editor.locator('#label-video [data-act="lock"].on').count()) === 1)
  await editor.click('#label-video [data-act="lock"]')

  // ---- sounds: several at once, each on its own ----
  await editor.click('#tool-music')
  await answerPicker(app, [song, song])
  await editor.click('#add-music')
  await editor.waitForFunction(() => window.__editor.store.project.sounds.length === 2, null, { timeout: 15000 })
  s = await state()
  check(`${tag}: several audio files can be added at once`, s.sounds.length === 2 && s.sounds[0].name === 'song.wav' && s.sounds[0].loop === true)
  check(`${tag}: each sound shows in the timeline with its waveform`, (await editor.locator('.blk.music-blk canvas.wave').count()) === 2)
  await editor.locator('#prop-music-volume').fill('0.3')
  await editor.uncheck('#prop-music-duck')
  await editor.locator('#prop-music-fadeout').fill('3')
  s = await state()
  const sel = s.sounds.find((m) => m.id === s.selection.id)
  check(`${tag}: a sound's volume, fades and "quieter while someone speaks" can be set`, approx(sel.volume, 0.3, 0.01) && sel.duck === false && sel.fadeOut === 3, JSON.stringify(sel))
  await editor.check('#prop-music-duck')
  // split and duplicate a sound, then drop the extras again
  await editor.click(`.blk.music-blk[data-sound="${sel.id}"]`, { position: { x: 12, y: 10 } })
  await editor.evaluate((t) => window.__editor.store.seek(t), sel.start + 3)
  await editor.click('#split')
  s = await state()
  check(`${tag}: a sound can be split`, s.sounds.length === 3 && s.sounds.some((m) => m.length < sel.length), `${s.sounds.length}`)
  await editor.click('#duplicate-sel')
  s = await state()
  check(`${tag}: a sound can be duplicated`, s.sounds.length === 4)
  for (let i = 0; i < 3; i++) {
    await editor.click('.blk.music-blk >> nth=0')
    await editor.click('#delete-sel')
  }
  s = await state()
  check(`${tag}: a sound can be removed`, s.sounds.length === 1, `${s.sounds.length}`)

  // ---- volume over time: dip the music, draw the line, record it while playing ----
  const mus = (await state()).sounds[0]
  const musEnv = () => editor.evaluate((id) => window.__editor.store.project.sounds.find((m) => m.id === id)?.volEnv ?? null, mus.id)
  await editor.click(`.blk.music-blk[data-sound="${mus.id}"]`, { position: { x: 12, y: 10 } })
  check(`${tag}: a sound has a "Volume over time" graph`, await editor.isVisible('#lvl-sound-graph'))
  await editor.evaluate((t) => window.__editor.store.seek(t), mus.start + 1)
  await editor.click('#lvl-sound-dip')
  let env = await musEnv()
  const low = env && env.filter((p) => p.v < 0.2)
  check(`${tag}: "Dip here" drops the music for a few seconds and brings it back`, !!env && env.length === 4 && low.length === 2 && env[0].v === 1 && env[3].v === 1 && low[0].t > 0.8, JSON.stringify(env))
  check(`${tag}: the dip is drawn as a line on the sound in the timeline`, (await editor.locator(`.blk.music-blk[data-sound="${mus.id}"] svg.lvl-tl polyline`).count()) === 1)
  const pts = await editor.locator('#lvl-sound-graph circle.lvl-pt').count()
  check(`${tag}: and as points in the graph`, pts === 4, `${pts} points`)
  await editor.locator('#lvl-sound-graph').scrollIntoViewIfNeeded()
  const box = await editor.locator('#lvl-sound-graph').boundingBox()
  // click half way between the two low points, wherever that is on the graph (its length depends on the sound), clear of every point
  const soundLen = await editor.evaluate((id) => window.__editor.store.project.sounds.find((m) => m.id === id).length, mus.id)
  const dipMid = (low[0].t + low[1].t) / 2
  await editor.mouse.click(box.x + 10 + (dipMid / soundLen) * (box.width - 20), box.y + box.height * 0.5)
  env = await musEnv()
  check(`${tag}: clicking the graph adds a point`, env.length === 5 && env.some((p) => Math.abs(p.v - 0.5) < 0.2 && p.t > low[0].t && p.t < low[1].t), JSON.stringify(env))
  const lastPt = editor.locator('#lvl-sound-graph circle.lvl-pt >> nth=2')
  const lp = await lastPt.boundingBox()
  await editor.mouse.move(lp.x + lp.width / 2, lp.y + lp.height / 2)
  await editor.mouse.down()
  await editor.mouse.move(lp.x + lp.width / 2, box.y + 8, { steps: 5 })
  await editor.mouse.up()
  env = await musEnv()
  check(`${tag}: dragging a point up makes the music louder there`, env[2].v > 0.85, JSON.stringify(env[2]))
  await editor.locator('#lvl-sound-graph circle.lvl-hit >> nth=2').dblclick()
  env = await musEnv()
  check(`${tag}: double-clicking a point takes it away`, env.length === 4, JSON.stringify(env))
  // the way a person really does it: nothing in the side panel has focus, and the mouse moves in many small steps
  await editor.evaluate(() => { document.activeElement?.blur?.(); window.__lvlGraph = document.querySelector('#lvl-sound-graph') })
  const before2 = (await musEnv())[2]
  const hit = await editor.locator('#lvl-sound-graph circle.lvl-hit >> nth=2').boundingBox()
  const hx = hit.x + hit.width / 2
  const hy = hit.y + hit.height / 2
  await editor.mouse.move(hx, hy)
  await editor.mouse.down()
  for (let i = 1; i <= 14; i++) await editor.mouse.move(hx - i * 3, hy + i * 2)
  await editor.mouse.up()
  const after2 = (await musEnv())[2]
  const sameGraph = await editor.evaluate(() => window.__lvlGraph === document.querySelector('#lvl-sound-graph'))
  check(`${tag}: a point can be dragged in one go with the mouse (both along and down), the graph staying put under it`, after2.t < before2.t - 0.3 && after2.v < before2.v - 0.1 && sameGraph, JSON.stringify({ before2, after2, sameGraph }))
  await editor.click('#lvl-sound-out')
  env = await musEnv()
  check(`${tag}: "Fade out from here" glides down and stays down`, env[env.length - 1].v === 0 && env.filter((p) => p.v < 0.05).length >= 1, JSON.stringify(env))
  await editor.click('#lvl-sound-clear')
  check(`${tag}: "Clear" takes the line away`, (await musEnv()) === null)
  await editor.click('#undo')
  check(`${tag}: and Undo puts it back`, (await musEnv())?.length === 2)
  await editor.click('#lvl-sound-clear')
  // record while playing: move the Level slider as the video plays
  await editor.check('#lvl-sound-rec')
  check(`${tag}: "Record while playing" shows a Level slider`, await editor.isVisible('#lvl-sound-level'))
  await editor.evaluate((t) => window.__editor.store.seek(t), mus.start + 0.2)
  await editor.evaluate(() => window.__editor.store.setPlaying(true))
  await sleep(700)
  await editor.locator('#lvl-sound-level').fill('0.2')
  await sleep(700)
  await editor.evaluate(() => window.__editor.store.setPlaying(false))
  env = await musEnv()
  check(`${tag}: moving the slider while it plays writes the level at that moment`, !!env && env.some((p) => Math.abs(p.v - 0.2) < 0.02 && p.t > 0.5), JSON.stringify(env))
  await editor.uncheck('#lvl-sound-rec')
  await editor.click('#lvl-sound-clear')

  // ---- separate a clip's sound, and save pieces on their own ----
  const blueId = (await state()).clips.find((x) => x.name === 'blue clip.mp4')?.id
  if (blueId) {
    const before = (await state()).sounds.length
    await editor.click(`.blk.clip[data-clip="${blueId}"]`)
    await editor.click('#prop-detach')
    s = await state()
    const blue = await editor.evaluate((id) => window.__editor.store.project.clips.find((c) => c.id === id), blueId)
    check(`${tag}: a video's sound can be separated into a sound of its own`, s.sounds.length === before + 1 && blue.hasAudio === false && s.sounds.some((m) => m.origin === 'split' && m.length > 0.05), JSON.stringify({ n: s.sounds.length, audio: blue.hasAudio, sounds: s.sounds.map((m) => ({ o: m.origin, media: m.media, start: m.start, length: m.length })), blue: { in: blue.in, out: blue.out, name: blue.name } }))
    check(`${tag}: the separated sound is a bar of its own in the timeline`, (await editor.locator('.blk.music-blk.split-blk').count()) === 1)
    await editor.click('#undo')
    s = await state()
    check(`${tag}: separating can be undone`, s.sounds.length === before)
  }
  const assetDir = path.join(userData, 'assets')
  fs.mkdirSync(assetDir, { recursive: true })
  const answerSave = (file) => app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, file)
  const wavOut = path.join(assetDir, 'voice.wav')
  await answerSave(wavOut)
  const savedAudio = await editor.evaluate(() => window.editor.saveAsset({ media: 'recording', from: 0, to: 3, what: 'audio', name: 'Recording' }))
  const wavInfo = fs.existsSync(wavOut) ? ff(['-hide_banner', '-i', wavOut]).stderr : ''
  check(`${tag}: the sound of the recording can be saved on its own`, !!savedAudio.path && /Audio: pcm/.test(wavInfo) && !/Video:/.test(wavInfo), JSON.stringify(savedAudio))
  const mp4Out = path.join(assetDir, 'picture.mp4')
  await answerSave(mp4Out)
  const savedVideo = await editor.evaluate(() => window.editor.saveAsset({ media: 'recording', from: 1, to: 3, what: 'video', name: 'Recording' }))
  const mp4Info = fs.existsSync(mp4Out) ? ff(['-hide_banner', '-i', mp4Out]).stderr : ''
  check(`${tag}: the video of a piece can be saved without its sound`, !!savedVideo.path && /Video: h264/.test(mp4Info) && !/Audio:/.test(mp4Info), JSON.stringify(savedVideo))

  // ---- title card ----
  await editor.click('#tool-titles')
  await store(() => window.__editor.store.seek(window.__editor.store.duration))
  await editor.click('#add-title-gradient')
  await editor.fill('#prop-card-title', 'Thanks for watching')
  s = await state()
  const card = await store(() => window.__editor.store.project.clips.find((k) => k.card)?.card)
  check(`${tag}: a title card can be added and its words changed`, card?.title === 'Thanks for watching' && s.clips[s.clips.length - 1].kind === 'image', JSON.stringify(card))

  // ---- brand colours and fonts ----
  await editor.click('#open-brand')
  check(`${tag}: "Your brand" opens`, await editor.isVisible('#brand-add-color'))
  await editor.fill('#brand-hex', '#7c3aed')
  await editor.click('#brand-add-color')
  const font = isWin ? 'C:\\Windows\\Fonts\\arial.ttf' : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f))
  if (font && fs.existsSync(font)) {
    await answerPicker(app, [font])
    await editor.click('#brand-add-font')
    await editor.waitForSelector('.brand-font', { timeout: 10000 })
  } else warn(`${tag}: no font file on this computer to try "Add a font"`)
  await editor.click('#brand-save')
  await sleep(300)
  s = await state()
  const saved = (await main.evaluate(() => window.api.getSettings())).brand
  check(`${tag}: new brand colours (and fonts) are kept`, s.brand.colors.includes('#7c3aed') && saved.colors.includes('#7c3aed') && (!font || saved.fonts.length === 1), JSON.stringify(saved))
  await editor.click('.blk.over >> nth=0')
  check(`${tag}: brand colours appear wherever something can be coloured`, (await editor.locator('#prop-style .swatch[data-color="#7c3aed"]').count()) === 1)
  if (font && fs.existsSync(font)) check(`${tag}: brand fonts appear in the font list`, (await editor.locator('#prop-font option').allTextContents()).some((t) => /\(yours\)/.test(t)))

  // ---- playing ----
  await store(() => window.__editor.store.seek(0))
  await editor.click('#play')
  await sleep(1600)
  const played = (await state()).playhead
  await editor.click('#play')
  check(`${tag}: playing moves the playhead along`, played > 0.8, `${played.toFixed(2)}s after 1.6 s`)
  const vt = await editor.evaluate(() => window.__editor.player.activeVideo?.currentTime ?? 0)
  check(`${tag}: and the video under it`, vt > 0.3, `${vt.toFixed(2)}`)

  // ---- crop ----
  await editor.click('#tool-crop')
  await editor.selectOption('#aspect', '1:1')
  const crop = await editor.textContent('#crop-size')
  const [kw, kh] = crop.split('×').map((x) => parseInt(x, 10))
  check(`${tag}: crop picks a square area`, kw === kh && kw > 100, crop)
  check(`${tag}: the preview is square while it is chosen... and stays cropped afterwards`, !!(await editor.locator('#crop-box').boundingBox()))
  await editor.click('#tool-comments')
  s = await state()
  const [cw, ch] = [s.out.width, s.out.height]
  log(`editor: ${s.duration.toFixed(1)} s, ${cw}×${ch}, ${s.overlays.length} overlays, ${s.clips.length} pieces, sounds ${s.sounds?.map((m) => m.name).join(', ')}`)

  await shot(editor, 'editor-tracks')
  // ---- save ----
  const saveDuration = s.duration
  const file = await save(app, editor, 'e2e-edited')
  validate('Edited (cut, comments, shapes, media, music, title, crop)', file, { width: cw, height: ch, audio: true, minSeconds: saveDuration - 0.7, maxSeconds: saveDuration + 0.8 })
  const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(ff(['-hide_banner', '-i', file]).stderr)
  const seconds = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0
  check(`${tag}: the saved video is as long as the editor said`, approx(seconds, saveDuration, 0.7), `${seconds.toFixed(2)}s vs ${saveDuration.toFixed(2)}s`)

  // what is drawn on the video is in the saved file, in the right place and colour
  const step = s.overlays.find((o) => o.kind === 'step')
  const tMid = (step.start + step.end) / 2
  const r = step.size * 0.8 * (ch / 1080)
  const sample = pixelAt(file, tMid, step.x * cw + r * 0.55, step.y * ch, cw, ch)
  check(`${tag}: the numbered step is in the saved video, in its colour and place`, nearColour(sample, [0xef, 0x44, 0x44], 45), `pixel ${sample} at ${tMid.toFixed(2)}s`)
  const b = s.overlays.find((o) => o.kind === 'bubble')
  const bs = b.size * (ch / 1080)
  const bp = pixelAt(file, tMid, b.x * cw + bs * 0.3, b.y * ch + bs * 0.65, cw, ch)
  check(`${tag}: the comment is in the saved video with the style chosen`, nearColour(bp, [0xfd, 0xe0, 0x47], 45), `pixel ${bp}`)
  const lastSecond = ff(['-hide_banner', '-sseof', '-1.5', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr
  const lastPeak = /max_volume: (-?[\d.]+) dB/.exec(lastSecond)
  check(`${tag}: the music plays under the whole video`, !!lastPeak, lastPeak ? `peak ${lastPeak[1]} dB near the end` : 'no audio at the end')
  const cardPx = pixelAt(file, saveDuration - 1, cw * 0.05, ch * 0.05, cw, ch)
  check(`${tag}: the title card is the last thing in the video`, nearColour(cardPx, [0x4f, 0x46, 0xe5], 70) || nearColour(cardPx, [0x93, 0x33, 0xea], 70) || (cardPx && cardPx[2] > 150 && cardPx[0] < 190), `pixel ${cardPx}`)
  return file
}

module.exports = { editorSuite }
