import { describe, expect, it } from 'vitest'
import { opensKeyboard } from './index'

const el = (tagName: string, type?: string, isContentEditable = false) => ({ tagName, isContentEditable, getAttribute: (n: string) => (n === 'type' ? (type ?? null) : null) })

describe('a tap outside a dialog while its field is typed in', () => {
  it('knows which fields have the on-screen keyboard open: text, numbers, a text box, editable text', () => {
    for (const type of [undefined, 'text', 'number', 'search', 'email', 'tel', 'date', 'password', 'NUMBER']) expect(opensKeyboard(el('INPUT', type)), String(type)).toBe(true)
    expect(opensKeyboard(el('TEXTAREA'))).toBe(true)
    expect(opensKeyboard(el('DIV', undefined, true))).toBe(true)
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'range', 'file']) expect(opensKeyboard(el('INPUT', type)), type).toBe(false)
    expect(opensKeyboard(el('SELECT'))).toBe(false)
    expect(opensKeyboard(el('BUTTON'))).toBe(false)
    expect(opensKeyboard(null)).toBe(false)
  })
})
