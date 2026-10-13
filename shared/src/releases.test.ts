import { describe, expect, it } from 'vitest'
import { RELEASES, RELEASE_NOTES_BASELINE, compareReleaseIds, isReleaseId, latestReleaseId, unseenReleases, type Release } from './releases'

const fixture: Release[] = [
  { id: '2026-09-15.1', date: '2026-09-15', title: 'Baseline', items: [{ text: 'a' }] },
  { id: '2026-09-20.1', date: '2026-09-20', title: 'Next', items: [{ text: 'b' }] },
  { id: '2026-09-20.2', date: '2026-09-20', title: 'Same day, later', items: [{ text: 'c' }] },
  { id: '2026-10-01.1', date: '2026-10-01', title: 'Later', items: [{ text: 'd' }] },
]

describe('§18 — release notes', () => {
  it('never shows the baseline or anything before it', () => {
    expect(unseenReleases(null, fixture).map((r) => r.id)).toEqual(['2026-10-01.1', '2026-09-20.2', '2026-09-20.1'])
    expect(unseenReleases('2026-01-01.1', fixture).map((r) => r.id)).toEqual(['2026-10-01.1', '2026-09-20.2', '2026-09-20.1'])
  })
  it('shows only what is newer than the last dismissed note, newest first', () => {
    expect(unseenReleases('2026-09-20.1', fixture).map((r) => r.id)).toEqual(['2026-10-01.1', '2026-09-20.2'])
    expect(unseenReleases('2026-10-01.1', fixture)).toEqual([])
  })
  it('knows the latest and recognises an id', () => {
    expect(latestReleaseId(fixture)).toBe('2026-10-01.1')
    expect(isReleaseId('2026-09-20.2', fixture)).toBe(true)
    expect(isReleaseId('2026-09-20.9', fixture)).toBe(false)
  })
  it('orders a day’s tenth release after its ninth', () => {
    expect(compareReleaseIds('2026-10-13.10', '2026-10-13.9')).toBeGreaterThan(0)
    expect(compareReleaseIds('2026-10-13.9', '2026-10-14.1')).toBeLessThan(0)
    expect(compareReleaseIds('2026-10-13.2', '2026-10-13.2')).toBe(0)
    const day: Release[] = ['2026-10-13.9', '2026-10-13.10', '2026-10-13.8'].map((id) => ({ id, date: '2026-10-13', title: id, items: [{ text: id }] }))
    expect(unseenReleases('2026-10-13.9', day).map((r) => r.id)).toEqual(['2026-10-13.10'])
    expect(latestReleaseId(day)).toBe('2026-10-13.10')
  })
  it('ships a well-formed list: unique ids, sorted newest first, baseline present', () => {
    const ids = RELEASES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort(compareReleaseIds).reverse()).toEqual(ids)
    expect(ids).toContain(RELEASE_NOTES_BASELINE)
    for (const r of RELEASES) {
      expect(r.id).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
      expect(r.id.startsWith(r.date)).toBe(true)
      expect(r.title.trim()).not.toBe('')
      expect(r.items.length).toBeGreaterThan(0)
    }
  })
})
