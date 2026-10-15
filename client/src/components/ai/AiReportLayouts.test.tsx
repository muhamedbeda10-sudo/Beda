import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SectionFigures, SectionTree } from './AiReportLayouts'

// §20 — a saved report's figures and trees, as a report reads.

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('a report’s headline figures', () => {
  it('reads the words and dates as a line on top, the numbers as cards of one size', () => {
    const html = renderToStaticMarkup(
      <SectionFigures
        columns={['Customer', 'Main items', 'Pieces to make', 'Done %', 'Weight (t)', 'Latest due date', 'Reject rate %']}
        rows={[['دريم مشرق للاغذيه ش.م.م', 22, '349', 16, 0.63, '2026-11-10', null]]}
      />,
    )
    const facts = html.slice(html.indexOf('report-facts'), html.indexOf('report-numbers'))
    const numbers = html.slice(html.indexOf('report-numbers'))
    expect(text(facts)).toContain('Customer دريم مشرق للاغذيه ش.م.م')
    expect(text(facts)).toContain('Latest due date 2026-11-10')
    expect(text(numbers)).toContain('Main items 22')
    expect(text(numbers)).toContain('Pieces to make 349')
    expect(text(numbers)).toContain('Weight (t) 0.63')
    expect(text(numbers)).not.toContain('Customer')
    // Nothing reads as a dash among the words, not as a number.
    expect(text(facts)).toContain('Reject rate % —')
  })

  it('shows every name of a tree in full, over several lines rather than cut', () => {
    const html = renderToStaticMarkup(
      <SectionTree
        columns={['key', 'parent', 'level', 'item', 'to_make']}
        rows={[['1', null, 'Main item', 'Long Span Frame Horizontal Bracing Tie : 1000 : X', 16]]}
        tree={{ key: 'key', parent: 'parent' }}
        truncated={false}
      />,
    )
    expect(html).toContain('Long Span Frame Horizontal Bracing Tie : 1000 : X')
    expect(html).toContain('whitespace-pre-wrap')
    expect(html).not.toMatch(/<td[^>]*truncate[^>]*>Long Span/)
  })
})
