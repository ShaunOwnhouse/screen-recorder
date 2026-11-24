import { cameraCorner, usesCameraSound, type CameraTrack, type Clip, type Corner, type Overlay, type Sound, type TextOverlay, type TitleCard } from '../../shared/project.ts'
import type { Actions } from './actions.ts'
import { openBrandKit } from './brand.ts'
import { CARD_STYLES, SYSTEM_FONTS } from './defaults.ts'
import { button, h, number, range, section, select, toggle } from './dom.ts'
import { luminance } from './draw.ts'
import { overlayLabel } from './timeline.ts'
import { fmtTime, type Store, type Tool } from './store.ts'

const PRESET_COLORS = ['#ffffff', '#111827', '#fde047', '#ef4444', '#3b82f6', '#22c55e']

const TOOLS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: 'comments', label: 'Comments', icon: 'M4 5h16v11H9l-5 4z' },
  { id: 'shapes', label: 'Shapes', icon: 'M4 4h9v9H4zM11 11h9v9h-9z' },
  { id: 'media', label: 'Media', icon: 'M3 6h18v12H3zM10 9v6l5-3z' },
  { id: 'music', label: 'Audio', icon: 'M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z' },
  { id: 'titles', label: 'Titles', icon: 'M5 6h14M12 6v13M9 19h6' },
  { id: 'cut', label: 'Cut', icon: 'M6 6l12 12M6 18L18 6M6 6a2.5 2.5 0 1 0 0 .01M6 18a2.5 2.5 0 1 0 0 .01' },
  { id: 'crop', label: 'Crop', icon: 'M7 3v14h14M3 7h14v14' }
]

function icon(path: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', path)
  svg.append(p)
  return svg
}

/** The tool rail and its drawer on the left, and the settings of whatever is selected on the right. */
export class Panels {
  private sig = ''

  constructor(
    private readonly store: Store,
    private readonly actions: Actions,
    private readonly els: { rail: HTMLElement; drawer: HTMLElement; props: HTMLElement },
    private readonly crop: { fit: () => void; select: HTMLSelectElement }
  ) {
    for (const t of TOOLS) {
      const b = h('button', { type: 'button', class: 'rail-btn', id: `tool-${t.id}`, 'aria-pressed': 'false', title: t.label, onClick: () => store.setTool(t.id) }, icon(t.icon), h('span', { text: t.label }))
      els.rail.append(b)
    }
    store.on((what) => {
      if (what === 'tool') this.renderRail()
      if (what === 'tool' || what === 'media' || what === 'brand') this.renderDrawer()
      if (what === 'selection' || what === 'media' || what === 'brand') this.renderProps(true)
      if (what === 'project') {
        this.renderDrawer()
        this.renderProps(false)
      }
    })
    this.renderRail()
    this.renderDrawer()
    this.renderProps(true)
  }

  private renderRail(): void {
    for (const t of TOOLS) this.els.rail.querySelector(`#tool-${t.id}`)?.setAttribute('aria-pressed', String(this.store.tool === t.id))
  }

  // ---------- drawer ----------

  private tile(id: string, label: string, preview: HTMLElement | string, onClick: () => void): HTMLElement {
    return h('button', { type: 'button', class: 'tile', id, onClick }, typeof preview === 'string' ? h('span', { class: 'tile-prev', text: preview }) : preview, h('span', { class: 'tile-label', text: label }))
  }

  private renderDrawer(): void {
    const s = this.store
    const a = this.actions
    const d = this.els.drawer
    const heading = (t: string): HTMLElement => h('h2', { class: 'drawer-title', text: t })
    const tip = (t: string): HTMLElement => h('p', { class: 'tip', text: t })
    const kids: HTMLElement[] = []
    switch (s.tool) {
      case 'comments':
        kids.push(
          heading('Comments & callouts'),
          button('+ Add a comment', () => a.addOverlay('bubble'), 'primary wide', { id: 'add-comment' }),
          h('div', { class: 'tiles' },
            this.tile('add-bubble', 'Speech bubble', h('span', { class: 'prev-bubble', text: 'Bubble' }), () => a.addOverlay('bubble')),
            this.tile('add-note', 'Sticky note', h('span', { class: 'prev-note', text: 'Note' }), () => a.addOverlay('note')),
            this.tile('add-text', 'Plain text', h('span', { class: 'prev-text', text: 'Text' }), () => a.addOverlay('text'))
          ),
          tip('A comment appears on the video from where the playhead is. Drag it on the video to move it, and use the timeline to change when it is shown.')
        )
        break
      case 'shapes':
        kids.push(
          heading('Shapes'),
          h('div', { class: 'tiles' },
            this.tile('add-arrow', 'Arrow', h('span', { class: 'prev-arrow', text: '➜' }), () => a.addOverlay('arrow')),
            this.tile('add-box', 'Highlight box', h('span', { class: 'prev-box' }), () => a.addOverlay('box')),
            this.tile('add-step', 'Numbered step', h('span', { class: 'prev-step', text: '1' }), () => a.addOverlay('step'))
          ),
          h('h2', { class: 'drawer-sub', text: 'Handy for screen recordings' }),
          h('div', { class: 'wide-list' },
            button('◎  Spotlight a spot', () => a.addOverlay('spotlight'), 'ghost wide', { id: 'add-spotlight' }),
            button('▦  Blur or hide something', () => a.addOverlay('blur'), 'ghost wide', { id: 'add-blur' }),
            button('⌕  Zoom in on an area', () => a.addOverlay('zoom'), 'ghost wide', { id: 'add-zoom' })
          ),
          tip('Spotlight darkens everything except one area. Blur hides private details. Zoom glides in on part of the screen, then back out.')
        )
        break
      case 'media': {
        const added = [...s.media.values()].filter((m) => m.kind !== 'audio' && m.id !== 'recording' && m.id !== 'camera')
        kids.push(
          heading('Media'),
          button('+ Add videos, pictures or audio', () => void a.addAny(), 'primary wide', { id: 'add-media' }),
          tip('Choose as many files as you like. Videos and pictures go into the video at the playhead, one after another; audio files go under it as sounds.'),
          button('▣  Add as picture-in-picture', () => void a.addPip(), 'ghost wide', { id: 'add-pip' }),
          tip('Shows it in a small window over the video instead — handy for a logo or a second view.')
        )
        if (s.project.camera) {
          const cam = s.project.camera
          kids.push(
            h('h2', { class: 'drawer-sub', text: 'Your face camera' }),
            cam.visible
              ? tip('It was recorded with the screen and is on the video. Click it on the video (or its bar in the timeline) to change it.')
              : button('Show my face camera again', () => s.patchCamera({ visible: true }), 'ghost wide', { id: 'show-camera' })
          )
        }
        if (added.length) {
          kids.push(
            h('h2', { class: 'drawer-sub', text: 'Added so far' }),
            h('div', { class: 'wide-list' }, ...added.map((m) => button(`${m.name}`, () => void a.addClips([m]), 'ghost wide small', { title: 'Add it again at the playhead' })))
          )
        }
        break
      }
      case 'music':
        kids.push(
          heading('Audio'),
          button('+ Add audio files', () => void a.addMusic(), 'primary wide', { id: 'add-music' }),
          tip('Choose one or many songs, voice-overs or sounds you have the right to use. Each one sits on its own bar under the video: drag it to move it, drag its ends to trim it, and use Split and Duplicate like on any other piece.'),
          ...(s.project.sounds.length
            ? [
                h('h2', { class: 'drawer-sub', text: 'In this video' }),
                h('div', { class: 'wide-list' },
                  ...s.project.sounds.map((m) =>
                    button(m.name, () => { s.select({ kind: 'sound', id: m.id }); s.seek(m.start) }, `ghost wide small${s.selection?.kind === 'sound' && s.selection.id === m.id ? ' on' : ''}`, { title: 'Select it' })))
              ]
            : []),
          tip('To work with the sound of a video or of your recording on its own, click that piece on the timeline and choose “Separate the sound”.')
        )
        break
      case 'titles':
        kids.push(
          heading('Title cards'),
          tip('A title card is a full-screen page with your words on it, for the start or end of the video, or to introduce a part. It goes in at the playhead.'),
          h('div', { class: 'tiles' }, ...CARD_STYLES.map((c) => this.tile(`add-title-${c.id}`, c.label, h('span', { class: `prev-card ${c.id}`, text: 'Title' }), () => a.addTitle(c.id))))
        )
        break
      case 'cut':
        kids.push(
          heading('Cut'),
          tip('Move the playhead to where you want to cut, then press Split. Click a piece and press Delete to take it out — what is after it moves up to close the gap. Drag the ends of a piece to trim it.'),
          button('✂  Split at the playhead  (S)', () => a.split(), 'primary wide', { id: 'cut-split' }),
          button('Delete the selected piece  (Del)', () => a.deleteSelected(), 'ghost wide', { id: 'cut-delete' })
        )
        break
      case 'crop':
        kids.push(heading('Crop'), tip('Drag the box on the video to choose the part to keep. Everything else is cut off from the whole video.'))
        kids.push(h('div', { class: 'psec' }, h('h3', { text: 'Shape' }), this.cropControls()))
        break
    }
    d.replaceChildren(...kids)
  }

  private cropControls(): HTMLElement {
    const s = this.store
    const sel = this.crop.select
    sel.hidden = false
    return h('div', { class: 'crop-controls' },
      sel,
      h('div', { class: 'crop-size-row' }, h('span', { class: 'muted', text: 'Size' }), h('span', { id: 'crop-size-label' })),
      button('Remove crop', () => {
        s.edit((p) => ({ ...p, crop: null }))
        s.setTool('comments')
      }, 'ghost wide', { id: 'crop-reset' })
    )
  }

  // ---------- properties ----------

  private swatches(current: string, pick: (c: string) => void, opts: { id?: string; none?: boolean } = {}): HTMLElement {
    const brand = this.store.brand.colors
    const all = [...PRESET_COLORS, ...brand.filter((c) => !PRESET_COLORS.includes(c))]
    const row = h('div', { class: 'swatches', id: opts.id })
    if (opts.none) row.append(h('button', { type: 'button', class: `swatch none${!current ? ' on' : ''}`, title: 'None', 'aria-label': 'No colour', onClick: () => pick('') }))
    for (const c of all) {
      row.append(h('button', {
        type: 'button', class: `swatch${c.toLowerCase() === current.toLowerCase() ? ' on' : ''}${brand.includes(c) ? ' brand' : ''}`, style: `background:${c}`,
        title: brand.includes(c) ? `${c} (your brand)` : c, 'aria-label': c, 'data-color': c, onClick: () => pick(c)
      }))
    }
    const custom = h('input', { type: 'color', class: 'swatch-custom', value: /^#[0-9a-f]{6}$/i.test(current) ? current : '#7c3aed', title: 'Any colour' })
    custom.addEventListener('input', () => pick(custom.value))
    row.append(custom)
    return row
  }

  private fontSelect(current: string, pick: (f: string) => void, id?: string): HTMLSelectElement {
    const options: Array<[string, string]> = [...this.store.brand.fonts.map((f): [string, string] => [f.name, `${f.name} (yours)`]), ...SYSTEM_FONTS]
    const el = select(options, current, pick, id)
    if (![...el.options].some((o) => o.value === current)) el.add(new Option(current, current), 0), (el.value = current)
    return el
  }

  private renderProps(force: boolean): void {
    const s = this.store
    const host = this.els.props
    const sel = s.selection
    const sig = sel ? `${sel.kind}:${sel.id}` : 'none'
    const editing = host.contains(document.activeElement) && document.activeElement !== host
    if (!force && editing && sig === this.sig) {
      this.fillCropLabel()
      return
    }
    this.sig = sig
    this.fillCropLabel()
    const kids: HTMLElement[] = []
    const o = s.selectedOverlay
    const c = s.selectedClip
    if (o) kids.push(...this.overlayProps(o))
    else if (c) kids.push(...this.clipProps(c))
    else if (s.selectedSound) kids.push(...this.soundProps(s.selectedSound))
    else if (sel?.kind === 'camera' && s.project.camera) kids.push(...this.cameraProps(s.project.camera))
    else {
      kids.push(
        h('div', { class: 'psec empty' },
          h('h3', { text: 'Nothing selected' }),
          h('p', { class: 'muted', text: 'Click a comment on the video, or a piece on the timeline, to change it here.' }),
          h('p', { class: 'muted', text: `Length ${fmtTime(s.duration)} · ${s.project.clips.length} piece${s.project.clips.length === 1 ? '' : 's'}${s.project.overlays.length ? ` · ${s.project.overlays.length} on top` : ''}` })
        )
      )
    }
    kids.push(
      h('div', { class: 'psec brand-row' }, button('Your brand colours & fonts…', () => openBrandKit(s, () => this.renderProps(true)), 'ghost wide', { id: 'open-brand' }))
    )
    host.replaceChildren(...kids)
  }

  private fillCropLabel(): void {
    const l = document.getElementById('crop-size-label')
    const t = document.getElementById('crop-size')
    if (l && t) l.textContent = t.textContent
  }

  private timeFields(o: Overlay): HTMLElement {
    const s = this.store
    return section('Shown from → to',
      h('div', { class: 'time-row' },
        number(o.start, 0, s.duration, 0.1, (v) => s.patchOverlay(o.id, { start: Math.min(s.snap(v), o.end - 0.1) }), 'prop-from'),
        h('span', { text: '→' }),
        number(o.end, 0.1, s.duration, 0.1, (v) => s.patchOverlay(o.id, { end: Math.max(s.snap(v), o.start + 0.1) }), 'prop-to')),
      h('div', { class: 'time-row' },
        button('Start here', () => s.patchOverlay(o.id, { start: Math.min(s.snap(s.playhead), o.end - 0.1) }), 'ghost small'),
        button('End here', () => s.patchOverlay(o.id, { end: Math.max(s.snap(s.playhead), o.start + 0.1) }), 'ghost small'))
    )
  }

  private overlayProps(o: Overlay): HTMLElement[] {
    const s = this.store
    const patch = (p: Record<string, unknown>, merge?: string): void => s.patchOverlay(o.id, p, merge ?? `p:${o.id}:${Object.keys(p)[0]}`)
    const title = o.kind === 'bubble' ? 'Comment' : o.kind === 'note' ? 'Note' : overlayLabel(o).split(' ')[0] === 'Step' ? 'Step' : overlayLabel(o)
    const out: HTMLElement[] = [h('h2', { class: 'props-title', text: o.kind === 'text' ? 'Text' : title })]

    if (o.kind === 'bubble' || o.kind === 'note' || o.kind === 'text') {
      const t = o as TextOverlay
      const ta = h('textarea', { id: 'prop-text', rows: 3, value: t.text, spellcheck: 'true' })
      ta.addEventListener('input', () => patch({ text: ta.value }, `text:${o.id}`))
      out.push(section('Text', ta))
      if (o.kind === 'text') {
        out.push(
          section('Colour', this.swatches(t.color, (c) => patch({ color: c }), { id: 'prop-color' })),
          toggleSection(toggle('Dark box behind the words', !!t.bg, (on) => patch({ bg: on ? '#111827cc' : '' }), 'prop-bg'))
        )
      } else {
        const presets: Array<[string, string]> = [['#ffffff', '#111827'], ['#fde047', '#1f2937'], ['#111827', '#ffffff'], ['#ef4444', '#ffffff'], ['#3b82f6', '#ffffff'], ['#22c55e', '#052e16']]
        const row = h('div', { class: 'swatches', id: 'prop-style' })
        for (const [bg, fg] of [...presets, ...s.brand.colors.filter((c) => !presets.some(([p]) => p === c)).map((c): [string, string] => [c, luminance(c) > 0.55 ? '#111827' : '#ffffff'])]) {
          row.append(h('button', {
            type: 'button', class: `swatch${t.bg.toLowerCase() === bg.toLowerCase() ? ' on' : ''}${s.brand.colors.includes(bg) ? ' brand' : ''}`, style: `background:${bg}`,
            'data-color': bg, 'aria-label': `Style ${bg}`, onClick: () => patch({ bg, color: fg })
          }))
        }
        out.push(section('Style', row))
      }
      out.push(
        section('Text size', range(t.size, 14, 140, 1, (v) => patch({ size: v }, `size:${o.id}`), (v) => String(v), 'prop-size')),
        section('Font', this.fontSelect(t.font, (f) => patch({ font: f }), 'prop-font')),
        section('Align', select([['left', 'Left'], ['center', 'Centre']], t.align, (v) => patch({ align: v }), 'prop-align'))
      )
    } else if (o.kind === 'arrow') {
      out.push(section('Colour', this.swatches(o.color, (c) => patch({ color: c }), { id: 'prop-color' })), section('Thickness', range(o.width, 3, 24, 1, (v) => patch({ width: v }, `w:${o.id}`))))
    } else if (o.kind === 'box') {
      out.push(
        section('Colour', this.swatches(o.color, (c) => patch(o.fill ? { color: c, fill: c } : { color: c }), { id: 'prop-color' })),
        section('Thickness', range(o.width, 2, 20, 1, (v) => patch({ width: v }, `w:${o.id}`))),
        section('Rounded corners', range(o.radius, 0, 80, 1, (v) => patch({ radius: v }, `r:${o.id}`))),
        toggleSection(toggle('Tint the inside', !!o.fill, (on) => patch({ fill: on ? o.color : null })))
      )
    } else if (o.kind === 'step') {
      out.push(
        section('Number', number(o.n, 1, 99, 1, (v) => patch({ n: Math.round(v) }), 'prop-n')),
        section('Colour', this.swatches(o.color, (c) => patch({ color: c }), { id: 'prop-color' })),
        section('Size', range(o.size, 24, 100, 1, (v) => patch({ size: v }, `sz:${o.id}`)))
      )
    } else if (o.kind === 'spotlight') {
      out.push(
        section('Shape', select([['ellipse', 'Oval'], ['rect', 'Rectangle']], o.shape, (v) => patch({ shape: v }), 'prop-shape')),
        section('How dark the rest goes', range(o.dim, 0.2, 0.95, 0.05, (v) => patch({ dim: v }, `dim:${o.id}`), (v) => `${Math.round(v * 100)}%`))
      )
    } else if (o.kind === 'blur') {
      out.push(
        section('Hide with', select([['blur', 'Blur'], ['pixelate', 'Pixels']], o.mode, (v) => patch({ mode: v }), 'prop-mode')),
        section('Strength', range(o.strength, 1, 10, 1, (v) => patch({ strength: v }, `st:${o.id}`))),
        h('p', { class: 'tip', text: 'Drag the box on the video over what you want to hide. It is hidden for the time shown below.' })
      )
    } else if (o.kind === 'zoom') {
      out.push(
        section('Glide time', range(o.ease, 0.2, 2, 0.1, (v) => patch({ ease: v }, `ease:${o.id}`), (v) => `${v.toFixed(1)} s`)),
        h('p', { class: 'tip', text: 'Drag the box on the video over the part to zoom in on. The video glides in, stays there, then glides back out.' })
      )
    } else if (o.kind === 'pip') {
      out.push(section('Size', range(o.w, 0.1, 0.7, 0.01, (v) => patch({ w: v }, `pw:${o.id}`), (v) => `${Math.round(v * 100)}%`)))
      if (o.hasAudio) out.push(section('Its sound', range(o.volume, 0, 1.5, 0.05, (v) => patch({ volume: v }, `pv:${o.id}`), (v) => `${Math.round(v * 100)}%`)))
    }

    out.push(this.timeFields(o))
    if (o.kind !== 'blur' && o.kind !== 'zoom') out.push(toggleSection(toggle('Fade in and out', o.fade, (on) => patch({ fade: on }), 'prop-fade')))
    out.push(
      h('div', { class: 'psec actions' },
        button('Duplicate', () => this.actions.duplicate(), 'ghost', { id: 'prop-duplicate' }),
        button('Delete', () => this.actions.deleteSelected(), 'danger-ghost', { id: 'prop-delete' }))
    )
    return out
  }

  private clipProps(c: Clip): HTMLElement[] {
    const s = this.store
    const patch = (p: Partial<Clip>, merge?: string): void => s.patchClip(c.id, p, merge ?? `c:${c.id}:${Object.keys(p)[0]}`)
    const index = s.project.clips.findIndex((x) => x.id === c.id)
    const out: HTMLElement[] = [h('h2', { class: 'props-title', text: c.card ? 'Title card' : c.kind === 'image' ? 'Picture' : c.kind === 'recording' ? 'Recording' : 'Video' }), h('p', { class: 'muted file-name', text: c.name })]
    if (c.card) out.push(...this.cardProps(c, c.card))
    if (c.kind === 'image') {
      out.push(section('Shown for', number(c.out - c.in, 0.5, 600, 0.5, (v) => patch({ out: s.snap(c.in + v) }), 'prop-length')))
    }
    if (c.kind !== 'image' && c.hasAudio) {
      out.push(section('Volume', range(c.volume, 0, 2, 0.05, (v) => patch({ volume: v }, `vol:${c.id}`), (v) => `${Math.round(v * 100)}%`, 'prop-volume')))
    }
    if (c.kind === 'recording' && c.hasAudio) {
      const t = s.project.tracks
      if (usesCameraSound(s.project)) {
        out.push(h('p', { class: 'tip good', text: t.pc ? 'Your voice comes from the webcam’s microphone, so the microphone recorded with the screen is off. The computer’s sound is kept.' : 'Your voice comes from the webcam’s microphone, so the sound recorded with the screen is off.' }))
      } else if (t.pc && t.mic) {
        out.push(section('Sound from the recording', select([['mix', 'Everything, as recorded'], ['pc', 'Computer sound only'], ['mic', 'My microphone only']], c.audioSource ?? 'mix', (v) => patch({ audioSource: v as Clip['audioSource'] }), 'prop-audio-source')))
        out.push(h('p', { class: 'tip', text: 'The computer’s sound (a video you played) and your microphone were recorded as two tracks, so you can keep just one — or use “Separate the sound” to work with it on its own.' }))
      }
    }
    if (index > 0) {
      out.push(
        toggleSection(toggle('Fade in from the piece before', c.transition === 'fade', (on) => patch({ transition: on ? 'fade' : 'cut' }), 'prop-transition')),
        c.transition === 'fade' ? section('Fade length', range(c.transitionDur, 0.2, 2, 0.1, (v) => patch({ transitionDur: s.snap(v) }, `td:${c.id}`), (v) => `${v.toFixed(1)} s`)) : h('span')
      )
    }
    if (c.kind !== 'image' && c.hasAudio) {
      out.push(
        h('div', { class: 'psec actions' },
          button('Separate the sound', () => this.actions.detach(c.id), 'ghost', { id: 'prop-detach', title: 'Take the sound off this piece so you can move, cut, turn down or save it on its own' }))
      )
    }
    out.push(
      h('div', { class: 'psec actions' },
        button('Split at playhead', () => this.actions.split(), 'ghost', { id: 'prop-split' }),
        button('Duplicate', () => this.actions.duplicate(), 'ghost', { id: 'prop-clip-duplicate' }),
        button('Delete', () => this.actions.deleteSelected(), 'danger-ghost', { id: 'prop-delete' }))
    )
    if (c.kind !== 'image' && !c.card) {
      out.push(
        h('div', { class: 'psec actions' },
          button('Save video only…', () => void this.actions.saveAsset('video', c.id), 'ghost', { id: 'prop-save-video', title: 'Save this piece as a picture-only file, with no sound' }),
          ...(c.hasAudio || c.kind === 'recording' ? [button('Save sound only…', () => void this.actions.saveAsset('audio', c.id), 'ghost', { id: 'prop-save-audio', title: 'Save just the sound of this piece as an audio file' })] : []))
      )
    }
    return out
  }

  private cardProps(c: Clip, card: TitleCard): HTMLElement[] {
    const s = this.store
    const patch = (p: Partial<TitleCard>, merge?: string): void => s.patchClip(c.id, { card: { ...card, ...p } }, merge ?? `card:${c.id}:${Object.keys(p)[0]}`)
    const title = h('input', { type: 'text', id: 'prop-card-title', value: card.title, class: 'text' })
    title.addEventListener('input', () => patch({ title: title.value }, `ct:${c.id}`))
    const sub = h('input', { type: 'text', id: 'prop-card-sub', value: card.subtitle, class: 'text' })
    sub.addEventListener('input', () => patch({ subtitle: sub.value }, `cs:${c.id}`))
    return [
      section('Title', title),
      section('Line underneath', sub),
      section('Background', this.swatches(card.bg[0], (col) => patch({ bg: [col, col] }), { id: 'prop-card-bg' })),
      section('Words', this.swatches(card.color, (col) => patch({ color: col }), { id: 'prop-card-color' })),
      section('Font', this.fontSelect(card.font, (f) => patch({ font: f }), 'prop-card-font')),
      section('Align', select([['center', 'Centre'], ['left', 'Left']], card.align, (v) => patch({ align: v as TitleCard['align'] }))),
    ]
  }

  private cameraProps(cam: CameraTrack): HTMLElement[] {
    const s = this.store
    const patch = (p: Partial<CameraTrack>, merge?: string): void => s.patchCamera(p, merge ?? `cam:${Object.keys(p)[0]}`)
    const shapes: Array<[CameraTrack['shape'], string, string]> = [['circle', 'Circle', '50%'], ['rounded', 'Rounded', '22%'], ['square', 'Square', '0']]
    const row = h('div', { class: 'shapes', id: 'prop-cam-shape' })
    for (const [id, label, radius] of shapes) {
      row.append(h('button', { type: 'button', class: `shape${cam.shape === id ? ' on' : ''}`, 'data-shape': id, onClick: () => patch({ shape: id }) }, h('i', { style: `border-radius:${radius}` }), label))
    }
    const corners: Array<[Corner, string]> = [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']]
    const sec = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} s`
    return [
      h('h2', { class: 'props-title', text: 'Face camera' }),
      section('Shape', row),
      section('Size', range(cam.w, 0.08, 0.6, 0.01, (v) => patch({ w: v, x: Math.min(cam.x, 1 - v), y: Math.min(cam.y, 1 - v * s.aspect) }, 'cam:size'), (v) => `${Math.round(v * 100)}%`, 'prop-cam-size')),
      section('Where', select([['', 'Move to a corner…'], ...corners], '', (v) => {
        if (v) patch(cameraCorner(cam, s.aspect, v as Corner))
      }, 'prop-cam-corner')),
      toggleSection(toggle('White border', cam.border, (on) => patch({ border: on }), 'prop-cam-border')),
      section('Fix lip-sync', range(cam.nudge, -1, 1, 0.01, (v) => patch({ nudge: v }, 'cam:nudge'), sec, 'prop-cam-nudge')),
      h('p', { class: 'tip good', text: 'Webcams are often a little late. If your voice is slightly ahead of your lips, move this up; if behind, down.' }),
      toggleSection(toggle('Fade in and out', cam.fade, (on) => patch({ fade: on }), 'prop-cam-fade')),
      ...(cam.hasAudio
        ? [
            section('Your voice comes from', select([['camera', 'The webcam’s microphone (voice and lips together)'], ['screen', 'The microphone recorded with the screen']], cam.audio ? 'camera' : 'screen', (v) => patch({ audio: v === 'camera' }), 'prop-cam-audio')),
            h('p', { class: 'tip good', text: cam.audio ? 'Your voice is taken from the webcam’s own recording, so it always matches your lips. Sound the computer played while recording is kept.' : 'Your voice is the microphone recorded with the screen. If it doesn’t match your lips, switch to the webcam’s microphone.' }),
            ...(cam.audio ? [section('Webcam sound volume', range(cam.volume, 0, 2, 0.05, (v) => patch({ volume: v }, 'cam:vol'), (v) => `${Math.round(v * 100)}%`, 'prop-cam-volume'))] : [])
          ]
        : [h('p', { class: 'tip', text: 'This camera recording has no sound of its own.' })]),
      h('div', { class: 'psec actions' },
        button('Save camera video…', () => void this.actions.saveAsset('camera-video', 'camera'), 'ghost', { id: 'prop-cam-save-video' }),
        ...(cam.hasAudio ? [button('Save camera sound…', () => void this.actions.saveAsset('camera-audio', 'camera'), 'ghost', { id: 'prop-cam-save-audio' })] : [])),
      h('div', { class: 'psec actions' }, button('Hide the camera', () => { patch({ visible: false }); s.select(null) }, 'danger-ghost', { id: 'prop-cam-hide' }))
    ]
  }

  private soundProps(m: Sound): HTMLElement[] {
    const s = this.store
    const patch = (p: Partial<Sound>, merge?: string): void => s.patchSound(m.id, p, merge ?? `m:${m.id}:${Object.keys(p)[0]}`)
    const pct = (v: number): string => `${Math.round(v * 100)}%`
    const sec = (v: number): string => `${v.toFixed(1)} s`
    return [
      h('h2', { class: 'props-title', text: m.origin === 'split' ? 'Sound from a video' : 'Music / audio' }),
      h('p', { class: 'muted file-name', text: m.name }),
      section('Volume', range(m.volume, 0, 2, 0.05, (v) => patch({ volume: v }), pct, 'prop-music-volume')),
      section('Fade in', range(m.fadeIn, 0, 8, 0.5, (v) => patch({ fadeIn: v }), sec, 'prop-music-fadein')),
      section('Fade out', range(m.fadeOut, 0, 8, 0.5, (v) => patch({ fadeOut: v }), sec, 'prop-music-fadeout')),
      toggleSection(toggle('Repeat to fill its length', m.loop, (on) => patch({ loop: on }), 'prop-music-loop')),
      toggleSection(toggle('Quieter while someone speaks', m.duck, (on) => patch({ duck: on }), 'prop-music-duck')),
      section('Starts at', number(m.start, 0, s.duration, 0.1, (v) => patch({ start: s.snap(v) }), 'prop-music-start')),
      section('Plays for', number(m.length, 0.1, 36000, 0.1, (v) => patch({ length: Math.max(0.1, s.snap(v)) }), 'prop-music-length')),
      section('Start inside the file at', number(m.offset, 0, Math.max(0, m.duration - 0.2), 0.5, (v) => patch({ offset: v }), 'prop-music-offset')),
      h('div', { class: 'psec actions' },
        button('Split at playhead', () => this.actions.split(), 'ghost', { id: 'prop-sound-split' }),
        button('Duplicate', () => this.actions.duplicate(), 'ghost', { id: 'prop-sound-duplicate' }),
        button('Remove', () => this.actions.removeSound(m.id), 'danger-ghost', { id: 'prop-music-remove' })),
      h('div', { class: 'psec actions' }, button('Save this sound…', () => void this.actions.saveAsset('audio', m.id), 'ghost', { id: 'prop-sound-save' }))
    ]
  }
}

function toggleSection(t: HTMLElement): HTMLElement {
  return h('div', { class: 'psec' }, t)
}
