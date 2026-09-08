import { describe, expect, it } from 'vitest'
import { mentionToken, plainText, segments, triggerAt } from './mentions'

describe('chat mentions', () => {
  it('splits a body into text and chips', () => {
    const body = `Hi @[Mohamed Beda](user:u1), see #[20095 · Beam](order:o1) on #[58](machine:58).`
    const s = segments(body)
    expect(s).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'mention', sigil: '@', kind: 'user', value: 'u1', label: 'Mohamed Beda' },
      { type: 'text', text: ', see ' },
      { type: 'mention', sigil: '#', kind: 'order', value: 'o1', label: '20095 · Beam' },
      { type: 'text', text: ' on ' },
      { type: 'mention', sigil: '#', kind: 'machine', value: '58', label: '58' },
      { type: 'text', text: '.' },
    ])
    expect(plainText(body)).toBe('Hi @Mohamed Beda, see #20095 · Beam on #58.')
  })

  it('writes a token that reads back', () => {
    const t = mentionToken('item', '125185TA3', 'XL Light Beam ]')
    expect(segments(t)).toEqual([{ type: 'mention', sigil: '#', kind: 'item', value: '125185TA3', label: 'XL Light Beam  ' }])
  })

  it('finds the trigger at the caret', () => {
    expect(triggerAt('hello @moh', 10)).toEqual({ sigil: '@', query: 'moh', start: 6 })
    expect(triggerAt('#', 1)).toEqual({ sigil: '#', query: '', start: 0 })
    expect(triggerAt('mail@x.com', 10)).toBeNull()
    expect(triggerAt('done @[A](user:1) ', 18)).toBeNull()
    expect(triggerAt('see #200 now', 8)).toEqual({ sigil: '#', query: '200', start: 4 })
  })
})
