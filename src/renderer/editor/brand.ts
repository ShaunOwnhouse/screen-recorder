import type { Brand } from '../../shared/types.ts'
import { button, h } from './dom.ts'
import type { Store } from './store.ts'

const api = window.editor

/** Makes the person's own fonts available to the editor's text. */
export async function loadBrandFonts(brand: Brand): Promise<void> {
  for (const f of brand.fonts) {
    if ([...document.fonts].some((x) => x.family.replace(/"/g, '') === f.name)) continue
    try {
      const data = await api.fontData(f.file)
      if (!data.byteLength) continue
      const face = new FontFace(f.name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      await face.load()
      document.fonts.add(face)
    } catch {
      // a font that can't be read is just left out
    }
  }
}

/** The "Your brand" window: the colours and fonts offered everywhere something can be coloured or written. */
export function openBrandKit(store: Store, done: () => void): void {
  const root = document.getElementById('modal')!
  let draft: Brand = JSON.parse(JSON.stringify(store.brand))
  const body = h('div', { class: 'modal-card brand-card', role: 'dialog', 'aria-label': 'Your brand' })

  const draw = (): void => {
    const colors = h('div', { class: 'brand-colors' })
    draft.colors.forEach((c, i) => {
      colors.append(
        h('span', { class: 'brand-chip', style: `background:${c}`, title: c }, h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${c}`, text: '×', onClick: () => { draft.colors.splice(i, 1); draw() } }))
      )
    })
    const picker = h('input', { type: 'color', id: 'brand-color-input', value: '#7c3aed' })
    const hex = h('input', { type: 'text', id: 'brand-hex', class: 'hex', placeholder: '#7c3aed', maxlength: 7, spellcheck: 'false' })
    picker.addEventListener('input', () => (hex.value = picker.value))
    const addColor = (): void => {
      const v = (hex.value || picker.value).trim()
      const m = /^#?([0-9a-f]{6})$/i.exec(v)
      if (m && !draft.colors.includes(`#${m[1].toLowerCase()}`) && draft.colors.length < 24) draft.colors.push(`#${m[1].toLowerCase()}`)
      draw()
    }
    const fonts = h('div', { class: 'brand-fonts' })
    for (const f of draft.fonts) {
      fonts.append(
        h('div', { class: 'brand-font' }, h('span', { class: 'sample', style: `font-family:"${f.name}", sans-serif`, text: f.name }), button('Remove', () => { draft.fonts = draft.fonts.filter((x) => x !== f); draw() }, 'ghost small'))
      )
    }
    if (!draft.fonts.length) fonts.append(h('p', { class: 'muted', text: 'No fonts of your own yet. Add a .ttf, .otf or .woff2 file and it will show up in the font lists.' }))
    body.replaceChildren(
      h('h2', { text: 'Your brand' }),
      h('p', { class: 'muted', text: 'Colours and fonts you add here are offered every time you colour or write something, in every video.' }),
      h('h3', { text: 'Colours' }),
      colors,
      h('div', { class: 'brand-add' }, picker, hex, button('Add colour', addColor, 'ghost', { id: 'brand-add-color' })),
      h('h3', { text: 'Fonts' }),
      fonts,
      button('Add a font file…', async () => {
        const f = await api.pickFont()
        if (f) {
          draft.fonts.push(f)
          await loadBrandFonts(draft)
          draw()
        }
      }, 'ghost', { id: 'brand-add-font' }),
      h('div', { class: 'modal-actions' },
        button('Cancel', () => close(), 'ghost', { id: 'brand-cancel' }),
        button('Save', async () => {
          store.brand = await api.saveBrand(draft)
          await loadBrandFonts(store.brand)
          store.emit('brand')
          close()
          done()
        }, 'primary', { id: 'brand-save' }))
    )
  }
  const close = (): void => {
    root.hidden = true
    root.replaceChildren()
  }
  draw()
  root.replaceChildren(body)
  root.hidden = false
  root.onclick = (e) => {
    if (e.target === root) close()
  }
  void draft
}
