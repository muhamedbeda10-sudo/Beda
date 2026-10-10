import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NeedsReviewBadge } from './parts'

describe('the "Needs review" mark', () => {
  it('names the compact flag as an image, with no hidden text that a scrolling table could lay out against the page', () => {
    const html = renderToStaticMarkup(<NeedsReviewBadge count={2} compact />)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Needs review: 2 open follow-ups"')
    expect(html).toContain('data-tip="Needs review: 2 open follow-ups: it reads “Needs review” until they are closed"')
    expect(html).not.toContain('sr-only')
    expect(html).not.toContain('>Needs review<')
  })

  it('says its words in full where there is room, and nothing at all with no follow-up open', () => {
    const html = renderToStaticMarkup(<NeedsReviewBadge count={1} />)
    expect(html).toContain('>Needs review</span>')
    expect(html).toContain('data-tip="1 open follow-up: it reads “Needs review” until it is closed"')
    expect(html).not.toContain('role="img"')
    expect(renderToStaticMarkup(<NeedsReviewBadge count={0} compact />)).toBe('')
  })
})
