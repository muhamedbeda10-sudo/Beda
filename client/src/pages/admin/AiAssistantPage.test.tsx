import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AiKeyState } from '@qc/shared/ai'
import { UsageByAutomation, describeKey } from './AiAssistantPage'

/** The card's words on the key, as text. */
const words = (key: AiKeyState) =>
  renderToStaticMarkup(<>{describeKey(key).state}</>)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')

describe('the key card', () => {
  const stored = { last4: 'WXYZ', updatedAt: '2026-10-01T09:30:00Z', updatedByName: 'Mona Adel' }

  it('names a key set here behind the server’s, and lets it be removed', () => {
    const key: AiKeyState = { set: true, source: 'environment', last4: 'ABCD', stored }
    const d = describeKey(key)
    expect(d.removable).toBe(true)
    expect(d.stored).toEqual(stored)
    expect(d.badge).toBe('From the server')
    const text = words(key)
    expect(text).toMatch(/^From the server's environment \(ANTHROPIC_API_KEY\), ending …ABCD\. It wins over a key set here\. /)
    expect(text).toMatch(/A key set here \(ending …WXYZ, changed .+ by Mona Adel\) is kept for when the server has none\.$/)
  })

  it('says when that key can no longer be read', () => {
    const text = words({ set: true, source: 'environment', last4: 'ABCD', stored: { ...stored, unreadable: true } })
    expect(text).toMatch(/is kept for when the server has none, but it can no longer be read — the server's secret has changed since\. Set it again, or remove it\.$/)
  })

  it('offers no Remove for the server’s key alone', () => {
    for (const key of [{ set: true, source: 'environment', last4: 'ABCD' }, { set: true, source: 'environment', last4: 'ABCD', stored: null }] satisfies AiKeyState[]) {
      const d = describeKey(key)
      expect(d.removable).toBe(false)
      expect(d.stored).toBeNull()
      expect(words(key)).toBe("From the server's environment (ANTHROPIC_API_KEY), ending …ABCD. It wins over a key set here.")
    }
  })

  it('keeps the app’s own key, an unreadable one and none as they were', () => {
    expect(describeKey({ set: true, source: 'app', ...stored })).toMatchObject({ removable: true, stored: null, badge: 'Set', tone: 'green' })
    expect(describeKey({ set: true, source: 'app', last4: 'WXYZ', unreadable: true })).toMatchObject({ removable: true, badge: 'Unreadable', tone: 'red' })
    expect(describeKey({ set: false, source: null })).toMatchObject({ removable: false, badge: 'Not set', tone: 'amber' })
  })
})

describe('the usage by automation', () => {
  /** The card as text, cell by cell. */
  const cells = (rows: Parameters<typeof UsageByAutomation>[0]['rows']) =>
    renderToStaticMarkup(<UsageByAutomation rows={rows} month="2026-10" />)
      .replace(/<(td|th)[^>]*>/g, ' | ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()

  it('lists what each scheduled report’s summaries cost, with its creator and runs', () => {
    const t = cells([{ automationId: 'a1', name: 'Daily rejects', creatorName: 'Mona Adel', costUsd: 0.42, runs: 9 }])
    expect(t).toMatch(/\| Daily rejects \| Mona Adel \| 9 \| \$0\.42/)
    expect(t).toContain('also counted above')
  })

  it('says when no report was summarised that month', () => {
    expect(cells([])).toContain('No scheduled report was summarised in October 2026.')
  })
})

