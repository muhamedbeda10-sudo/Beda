import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiSuggestions } from './AiSuggestions'

// §22 — the chips are the next questions, or the person's likely replies when the answer asks them something:
// their label names neither.
describe('the suggestions under an answer', () => {
  it('are labelled neutrally, to the eye and to a screen reader', () => {
    const html = renderToStaticMarkup(<AiSuggestions questions={['Yes, every 10 minutes', 'Only line 3']} onPick={() => {}} />)
    expect(html).toContain('role="group" aria-label="Suggestions"')
    expect(html).toMatch(/<\/svg> Suggestions<\/p>/)
    expect(html).toContain('Yes, every 10 minutes')
    expect(html).toContain('data-tip="Put this in the box"')
    expect(html).not.toContain('Ask next')
  })

  it('draw nothing when there is nothing to suggest', () => {
    expect(renderToStaticMarkup(<AiSuggestions questions={[]} onPick={() => {}} />)).toBe('')
  })
})
