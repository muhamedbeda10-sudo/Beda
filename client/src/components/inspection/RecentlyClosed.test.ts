import { describe, expect, it } from 'vitest'
import { closedOn, closedPanelDays } from './RecentlyClosed'

const CAIRO = 'Africa/Cairo'

describe('the sessions closed today', () => {
  it('reads today as the factory day: at 02:00 it is still the night shift’s', () => {
    // 02:00 on 20 October in Cairo (UTC+3).
    expect(closedPanelDays(Date.parse('2026-10-19T23:00:00Z'), CAIRO)).toEqual({ today: '2026-10-19', yesterday: '2026-10-18' })
    expect(closedPanelDays(Date.parse('2026-10-20T05:00:00Z'), CAIRO)).toEqual({ today: '2026-10-20', yesterday: '2026-10-19' })
  })

  it('keeps the closes of today’s factory day, the night’s included, latest first', () => {
    const sessions = [
      { id: 'evening', closedAt: '2026-10-19T17:00:00Z' }, // 20:00 on the 19th
      { id: 'night', closedAt: '2026-10-19T23:30:00Z' }, // 02:30 on the 20th: still the 19th's
      { id: 'morning', closedAt: '2026-10-20T05:30:00Z' }, // 08:30 on the 20th
      { id: 'earlier', closedAt: '2026-10-19T04:00:00Z' }, // 07:00 on the 19th: the 18th's
      { id: 'open', closedAt: undefined },
    ]
    expect(closedOn(sessions, '2026-10-19', CAIRO).map((s) => s.id)).toEqual(['night', 'evening'])
  })
})
