import { describe, expect, it } from 'vitest'
import { automationLinkFilters, dueView, durationWords, emptyListWords, mayOpenAutomation, factoryInstant, factoryMoment, factoryTimestamp, factoryWallTime, followUpLinks, followUpsQuery, isOverdue, isStatusFilter } from './wording'

describe('the follow-ups list as the API takes it', () => {
  it('sends the scope always and leaves out what is not set', () => {
    expect(followUpsQuery({ scope: 'mine', status: 'any', overdue: false, automationId: null })).toBe('?scope=mine')
    expect(followUpsQuery({ scope: 'all', status: 'done', overdue: false, automationId: null })).toBe('?scope=all&status=done')
  })

  it('asks for the follow-ups still to do as both statuses that are not done', () => {
    expect(followUpsQuery({ scope: 'mine', status: 'active', overdue: false, automationId: null })).toBe('?scope=mine&status=open%2Cin_progress')
  })

  it('narrows to the overdue ones, one automation, one session, and walks on from a follow-up', () => {
    expect(followUpsQuery({ scope: 'all', status: 'in_progress', overdue: true, automationId: 'a-1', sessionId: 's-1' }, 'f-9')).toBe(
      '?scope=all&status=in_progress&overdue=true&automationId=a-1&sessionId=s-1&before=f-9',
    )
  })

  it('opens an automation’s follow-ups not done, everyone’s for those who may see them, as its count has them', () => {
    expect(automationLinkFilters(true)).toEqual({ scope: 'all', status: 'active', overdue: false })
    expect(automationLinkFilters(false)).toEqual({ scope: 'mine', status: 'active', overdue: false })
  })

  it('says why the list is empty: the filters, every one done, or none yet at all', () => {
    expect(emptyListWords({ filtersSet: true, status: 'active', scope: 'mine', anyDone: false }).title).toBe('No follow-up matches')
    // Someone never given one is not told that every one is done.
    expect(emptyListWords({ filtersSet: false, status: 'active', scope: 'mine', anyDone: false })).toMatchObject({ title: 'No follow-ups for you yet' })
    expect(emptyListWords({ filtersSet: false, status: 'active', scope: 'all', anyDone: false }).title).toBe('No follow-ups yet')
    expect(emptyListWords({ filtersSet: false, status: 'active', scope: 'mine', anyDone: true })).toEqual({ title: 'Nothing left to do', hint: 'Every follow-up of yours is done.' })
    expect(emptyListWords({ filtersSet: false, status: 'active', scope: 'all', anyDone: null })).toEqual({ title: 'Nothing left to do' })
    expect(emptyListWords({ filtersSet: false, status: 'done', scope: 'mine', anyDone: null })).toEqual({ title: 'No follow-ups' })
  })

  it('leads to an automation’s page only those it opens for: the assistant’s owner, and its creator', () => {
    const own = new Set(['a-1'])
    expect(mayOpenAutomation('a-9', { owner: true, automations: true, own: null })).toBe(true)
    expect(mayOpenAutomation('a-1', { owner: false, automations: true, own })).toBe(true)
    // Someone who may create automations, on another person's: it would answer "not found".
    expect(mayOpenAutomation('a-9', { owner: false, automations: true, own })).toBe(false)
    expect(mayOpenAutomation('a-1', { owner: false, automations: true, own: null })).toBe(false)
    expect(mayOpenAutomation('a-1', { owner: false, automations: false, own })).toBe(false)
    expect(mayOpenAutomation(null, { owner: true, automations: true, own })).toBe(false)
  })

  it('knows its status filters and nothing else', () => {
    expect(['active', 'open', 'in_progress', 'done', 'any'].every(isStatusFilter)).toBe(true)
    expect(isStatusFilter('closed')).toBe(false)
    expect(isStatusFilter(undefined)).toBe(false)
  })
})

describe('a deadline in words', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString()
  const MIN = 60_000
  const H = 60 * MIN

  it('says a stretch of time in a word or two, rounded down, never under a minute', () => {
    expect(durationWords(0)).toBe('1 min')
    expect(durationWords(59 * MIN + 59_000)).toBe('59 min')
    expect(durationWords(H)).toBe('1 h')
    expect(durationWords(47 * H + 59 * MIN)).toBe('47 h')
    expect(durationWords(48 * H)).toBe('2 days')
    expect(durationWords(-5 * MIN)).toBe('1 min')
  })

  it('reads a deadline ahead as "in …", amber within a day', () => {
    expect(dueView({ dueAt: at(3 * H), status: 'open' }, now)).toEqual({ words: 'in 3 h', tone: 'soon' })
    expect(dueView({ dueAt: at(24 * H), status: 'in_progress' }, now)).toEqual({ words: 'in 24 h', tone: 'soon' })
    expect(dueView({ dueAt: at(3 * 24 * H), status: 'open' }, now)).toEqual({ words: 'in 3 days', tone: 'later' })
  })

  it('reads a missed deadline as overdue, and a closed follow-up as nothing to chase', () => {
    expect(dueView({ dueAt: at(-90 * MIN), status: 'open' }, now)).toEqual({ words: '1 h overdue', tone: 'overdue' })
    expect(dueView({ dueAt: at(-5 * 24 * H), status: 'in_progress' }, now)).toEqual({ words: '5 days overdue', tone: 'overdue' })
    expect(dueView({ dueAt: at(-5 * 24 * H), status: 'done' }, now)).toEqual({ words: '', tone: 'done' })
  })

  it('counts a follow-up overdue only while it is not done and past its deadline', () => {
    expect(isOverdue({ dueAt: at(-MIN), status: 'open' }, now)).toBe(true)
    expect(isOverdue({ dueAt: at(-MIN), status: 'done' }, now)).toBe(false)
    expect(isOverdue({ dueAt: at(MIN), status: 'in_progress' }, now)).toBe(false)
  })
})

describe('where a follow-up leads', () => {
  it('opens its session and its sample in History, and its order as History’s search', () => {
    expect(followUpLinks({ sessionId: 's 1', sampleId: 'x1', orderNumber: ' 20480-Ph3.4 ' })).toEqual({
      session: '/history?session=s%201',
      sample: '/history?session=s%201&sample=x1',
      order: '/history?q=20480-Ph3.4',
    })
  })

  it('has no sample link without its session, and nothing for what it does not name', () => {
    expect(followUpLinks({ sampleId: 'x1' })).toEqual({ session: null, sample: null, order: null })
    expect(followUpLinks({ orderNumber: '   ' }).order).toBeNull()
  })
})

describe('a deadline on the factory’s clock', () => {
  it('reads an instant as the zone’s wall time for a date-and-time field', () => {
    expect(factoryWallTime('2026-10-10T12:34:56Z', 'UTC')).toBe('2026-10-10T12:34')
    expect(factoryWallTime('2026-10-10T20:00:00Z', 'Asia/Tokyo')).toBe('2026-10-11T05:00')
    expect(factoryWallTime('not a date', 'UTC')).toBe('')
  })

  it('turns a wall time back into the instant, both ways round', () => {
    expect(factoryInstant('2026-10-11T05:00', 'Asia/Tokyo')).toBe('2026-10-10T20:00:00.000Z')
    expect(factoryInstant('2026-07-01T09:15', 'America/New_York')).toBe('2026-07-01T13:15:00.000Z')
    expect(factoryInstant('2026-01-15T09:15', 'America/New_York')).toBe('2026-01-15T14:15:00.000Z')
    for (const iso of ['2026-03-08T12:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-12-31T23:59:00.000Z']) {
      expect(factoryInstant(factoryWallTime(iso, 'America/New_York'), 'America/New_York')).toBe(iso)
    }
  })

  it('takes an hour the clock reads twice as its first time, and a skipped hour as just after the jump', () => {
    // New York falls back from 02:00 EDT to 01:00 EST on 1 November 2026.
    expect(factoryInstant('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
    // …and jumps from 02:00 EST to 03:00 EDT on 8 March 2026: 02:30 does not exist and reads as 03:30.
    expect(factoryInstant('2026-03-08T02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z')
    expect(factoryInstant('2026-03-08T03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z')
  })

  it('says a moment on the factory’s clock, near days by name', () => {
    const now = new Date('2026-10-10T09:00:00Z')
    expect(factoryMoment('2026-10-10T20:30:00Z', 'Asia/Tokyo', now)).toBe('Tomorrow, 05:30')
    expect(factoryMoment('2026-10-10T05:00:00Z', 'UTC', now)).toBe('Today, 05:00')
    expect(factoryMoment('2026-10-09T23:10:00Z', 'UTC', now)).toBe('Yesterday, 23:10')
    expect(factoryMoment('2026-10-12T08:00:00Z', 'UTC', now)).toBe('Oct 12, 08:00')
    expect(factoryMoment('2025-12-30T08:00:00Z', 'UTC', now)).toBe('Dec 30, 2025, 08:00')
    expect(factoryMoment(null, 'UTC', now)).toBe('—')
    expect(factoryTimestamp('2026-10-10T08:00:00Z', 'UTC')).toBe('Sat, Oct 10, 2026, 08:00 factory time')
    expect(factoryTimestamp('', 'UTC')).toBe('')
  })

  it('refuses what is not a wall time', () => {
    expect(factoryInstant('', 'UTC')).toBeNull()
    expect(factoryInstant('2026-02-30T10:00', 'UTC')).toBeNull()
    expect(factoryInstant('2026-13-01T10:00', 'UTC')).toBeNull()
    expect(factoryInstant('2026-10-10 10:00', 'UTC')).toBeNull()
  })
})
