/** Tiny helpers for building the editor's panels. */

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Record<string, unknown> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = String(v)
    else if (k === 'text') el.textContent = String(v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') (el as unknown as Record<string, unknown>)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c) el.append(c)
  return el
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'psec' }, h('h3', { text: title }), ...children)
}

export function button(label: string, onClick: () => void, cls = 'ghost', extra: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: cls, text: label, onClick, ...extra })
}

export function range(
  value: number, min: number, max: number, step: number, onInput: (v: number) => void, format: (v: number) => string = String, id?: string
): HTMLElement {
  const out = h('span', { class: 'range-val', text: format(value) })
  const input = h('input', { type: 'range', min, max, step, value, id })
  input.addEventListener('input', () => {
    const v = Number(input.value)
    out.textContent = format(v)
    onInput(v)
  })
  return h('div', { class: 'range' }, input, out)
}

export function toggle(label: string, checked: boolean, onChange: (on: boolean) => void, id?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', class: 'toggle', checked, id })
  input.addEventListener('change', () => onChange(input.checked))
  return h('label', { class: 'row-toggle' }, h('span', { text: label }), input)
}

export function select(options: Array<[string, string]>, value: string, onChange: (v: string) => void, id?: string): HTMLSelectElement {
  const el = h('select', { id }, ...options.map(([v, l]) => h('option', { value: v, text: l })))
  el.value = value
  el.addEventListener('change', () => onChange(el.value))
  return el
}

export function number(value: number, min: number, max: number, step: number, onChange: (v: number) => void, id?: string): HTMLInputElement {
  const el = h('input', { type: 'number', min, max, step, value: Number(value.toFixed(2)), id, class: 'num' })
  el.addEventListener('change', () => {
    const v = Number(el.value)
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
  })
  return el
}
