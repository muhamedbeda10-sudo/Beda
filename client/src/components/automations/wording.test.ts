import { describe, expect, it } from 'vitest'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiAutomationPart, Automation, AutomationDraft, AutomationRun, AutomationTestResponse, AutomationWeekday } from '@qc/shared/automation'
import {
  PROPOSAL_STATE_LABEL,
  PROPOSAL_STATE_TONE,
  applyEdits,
  assigneePhrase,
  assigneeView,
  automationStatus,
  automationSummary,
  automationSwitch,
  channelsText,
  checkAutomationForm,
  describeDueHours,
  editInChatText,
  editsFromForm,
  linkedValuesLines,
  existingCases,
  factoryMoment,
  factoryTimestamp,
  formFromDefinition,
  formPeriod,
  hasEdits,
  intervalOptions,
  knownWatchColumns,
  listWords,
  matchedText,
  noNextRunText,
  periodPhrase,
  recipientPhrase,
  recipientViews,
  replaceAutomationPart,
  revisedProposalId,
  runFigures,
  runOutcome,
  runToast,
  stoppedText,
  supersedeAutomationPart,
  supersedeParts,
  testSummary,
  whenText,
} from './wording'

const MONA = '11111111-1111-4111-8111-111111111111'
const BASEM = '22222222-2222-4222-8222-222222222222'

const watch: AutomationDraft = {
  kind: 'watch',
  name: 'Holds on line 3',
  description: 'Tells the supervisors about every new hold on line 3.',
  language: 'en',
  watch: {
    sql: 'SELECT sample_id, machine, inspector_id, session_id FROM ai.holds',
    keyColumn: 'sample_id',
    everyMinutes: 5,
    titleTemplate: 'Hold on {{machine}}',
    bodyTemplate: 'Sample {{sample_id}}',
    sessionColumn: 'session_id',
  },
  recipients: [{ kind: 'role', role: 'supervisor' }, { kind: 'user', userId: MONA }],
  channels: { bell: true, chat: false },
  actions: { notify: true, followUp: { assignee: { kind: 'column', column: 'inspector_id' }, dueHours: 24 } },
}

const report: AutomationDraft = {
  kind: 'report',
  name: 'Daily rejects',
  description: 'Yesterday’s rejects by machine, every morning.',
  language: 'en',
  schedule: {
    cadence: 'daily',
    time: '08:00',
    weekdays: [6, 0, 1, 2, 3, 4],
    period: { kind: 'yesterday' },
    sections: [{ title: 'Rejects by machine', sql: 'SELECT 1' }],
    summary: true,
  },
  recipients: [{ kind: 'role', role: 'admin' }],
  channels: { bell: true, chat: true },
  actions: { notify: true, followUp: null },
}

const people = new Map([
  [MONA, { id: MONA, name: 'Mona Adel' }],
  [BASEM, { id: BASEM, name: 'Basem Fathy' }],
])

describe('an automation in words', () => {
  it('says how long a deadline is, in days and hours', () => {
    expect(describeDueHours(1)).toBe('1 hour')
    expect(describeDueHours(5)).toBe('5 hours')
    expect(describeDueHours(24)).toBe('1 day')
    expect(describeDueHours(36)).toBe('1 day 12 hours')
    expect(describeDueHours(720)).toBe('30 days')
    expect(describeDueHours(0)).toBe('—')
  })

  it('names the channels and reads a list out', () => {
    expect(channelsText({ bell: true, chat: true })).toBe('The bell and the chat')
    expect(channelsText({ bell: false, chat: true })).toBe('The chat')
    expect(listWords([])).toBe('nobody')
    expect(listWords(['A'])).toBe('A')
    expect(listWords(['A', 'B'])).toBe('A and B')
    expect(listWords(['A', 'B', 'C'])).toBe('A, B and C')
    expect(listWords(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
  })

  it('names recipients: a person from the list or as the server named them, a role, a column — the invalid ones marked', () => {
    const known = [{ kind: 'user' as const, userId: BASEM, label: 'Basem (old name)', invalid: true }]
    const list = [{ kind: 'user' as const, userId: MONA }, { kind: 'user' as const, userId: BASEM }, { kind: 'role' as const, role: 'supervisor' as const }, { kind: 'column' as const, column: 'inspector_id' }]
    // Without the people list: the server's names and its word on validity.
    expect(recipientViews(list, null, known)).toEqual([
      { kind: 'user', userId: MONA, label: 'Unknown account' },
      { kind: 'user', userId: BASEM, label: 'Basem (old name)', invalid: true },
      { kind: 'role', role: 'supervisor', label: 'Every supervisor' },
      { kind: 'column', column: 'inspector_id', label: 'People in "inspector_id"' },
    ])
    // With it: only an active account is valid; a column the result lacks is not.
    const withList = recipientViews(list, new Map([[MONA, { id: MONA, name: 'Mona Adel' }]]), known, ['sample_id'])
    expect(withList[0]).toEqual({ kind: 'user', userId: MONA, label: 'Mona Adel' })
    expect(withList[1]).toMatchObject({ label: 'Basem (old name)', invalid: true })
    expect(withList[3]).toMatchObject({ label: 'People in "inspector_id"', invalid: true })
  })

  it('names an assignee', () => {
    expect(assigneeView({ kind: 'creator' }, null, 'Mona Adel')).toEqual({ kind: 'creator', label: 'Mona Adel (creator)' })
    expect(assigneeView({ kind: 'user', userId: BASEM }, people, 'Mona Adel')).toEqual({ kind: 'user', userId: BASEM, label: 'Basem Fathy' })
    expect(assigneeView({ kind: 'column', column: 'x' }, people, 'Mona Adel', undefined, ['y'])).toEqual({ kind: 'column', column: 'x', label: 'The person in "x"', invalid: true })
  })

  it('names recipients and assignees as a sentence does, where a chip’s capital would read wrong', () => {
    expect(recipientPhrase({ kind: 'role', role: 'admin', label: 'Every administrator' })).toBe('every administrator')
    expect(recipientPhrase({ kind: 'column', column: 'inspector_id', label: 'People in "inspector_id"' })).toBe('the people in "inspector_id"')
    // A person keeps their name as written.
    expect(recipientPhrase({ kind: 'user', userId: MONA, label: 'Mona Adel' })).toBe('Mona Adel')
    expect(assigneePhrase({ kind: 'column', column: 'inspector_id', label: 'The person in "inspector_id"' })).toBe('the person in "inspector_id"')
    expect(assigneePhrase({ kind: 'creator', label: 'Mona Adel (creator)' })).toBe('Mona Adel (creator)')
  })

  it('sums a watch up in plain words: when, whom it tells where, and the follow-up', () => {
    const recipients = recipientViews([...watch.recipients, { kind: 'column', column: 'inspector_id' }], people)
    expect(automationSummary({ ...watch, recipients, assignee: { kind: 'column', column: 'inspector_id', label: 'The person in "inspector_id"' } })).toBe(
      'Every 5 minutes it looks for new cases. Each new case is told to every supervisor, Mona Adel and the people in "inspector_id" on the bell, and gets a follow-up for the person in "inspector_id", due 1 day after the case.',
    )
    const quiet = { ...watch, actions: { notify: false, followUp: { assignee: { kind: 'creator' as const }, dueHours: 4 } } }
    expect(automationSummary({ ...quiet, recipients: [], assignee: { kind: 'creator', label: 'Mona Adel (creator)' } })).toBe(
      'Every 5 minutes it looks for new cases. Each new case gets a follow-up for Mona Adel (creator), due 4 hours after the case.',
    )
    expect(automationSummary({ ...watch, actions: { notify: true, followUp: null }, recipients: recipientViews(watch.recipients, people) })).toBe(
      'Every 5 minutes it looks for new cases. Each new case is told to every supervisor and Mona Adel on the bell.',
    )
  })

  it('sums a report up: its schedule in factory time, its sections over its period, its summary, its people', () => {
    expect(automationSummary({ ...report, recipients: recipientViews(report.recipients, null) })).toBe(
      'Saturday to Thursday at 08:00 (factory time) it runs 1 section over yesterday, adds a short summary written by the assistant, and sends the result to every administrator on the bell and the chat.',
    )
    const plain = { ...report, schedule: { ...report.schedule!, cadence: 'weekly' as const, weekdays: undefined, weekday: 0 as const, period: undefined, summary: false } }
    expect(automationSummary({ ...plain, recipients: [{ kind: 'user', userId: MONA, label: 'Mona Adel' }] })).toBe('Every Sunday at 08:00 (factory time) it runs 1 section and sends the result to Mona Adel on the bell and the chat.')
    expect(whenText(report)).toBe('Saturday to Thursday at 08:00')
    expect(whenText(watch)).toBe('Every 5 minutes')
  })

  it('says in which hours and on which days a watch looks, when it is kept to some', () => {
    const shift = { ...watch, watch: { ...watch.watch!, hours: { from: '05:00', to: '10:00' }, weekdays: [6, 0, 1, 2, 3, 4] as AutomationWeekday[] } }
    expect(whenText(shift)).toBe('Every 5 minutes from 05:00 to 10:00, Saturday to Thursday')
    const recipients = recipientViews(watch.recipients, people)
    expect(automationSummary({ ...shift, actions: { notify: true, followUp: null }, recipients })).toBe(
      'Every 5 minutes from 05:00 to 10:00, Saturday to Thursday (factory time), it looks for new cases. Each new case is told to every supervisor and Mona Adel on the bell.',
    )
    const days = { ...watch, watch: { ...watch.watch!, weekdays: [1, 2, 3, 4, 5] as AutomationWeekday[] } }
    expect(automationSummary({ ...days, actions: { notify: true, followUp: null }, recipients })).toBe(
      'Every 5 minutes, Monday to Friday, it looks for new cases. Each new case is told to every supervisor and Mona Adel on the bell.',
    )
    // All seven days is every day: nothing to say.
    expect(whenText({ ...watch, watch: { ...watch.watch!, weekdays: [0, 1, 2, 3, 4, 5, 6] } })).toBe('Every 5 minutes')
  })

  it('says what the trial run found and what activation does with the cases matching now', () => {
    expect(matchedText(0, false)).toBe('No case matched.')
    expect(matchedText(1, false)).toBe('1 case matched.')
    expect(matchedText(500, true)).toBe('500+ cases matched.')
    expect(existingCases({ matched: 0 }, false)).toEqual({ offer: null, text: 'Only cases that appear after you activate it will fire.' })
    expect(existingCases({ matched: 3 }, false)).toEqual({
      offer: 'Also alert on the 3 cases that match now',
      text: 'The 3 cases matching now are recorded as already seen; only cases that appear later will fire.',
    })
    expect(existingCases({ matched: 1 }, true).text).toBe('The case matching now will fire on its first run, then each new one as it appears.')
    expect(existingCases({ matched: 500, truncated: true }, false)).toEqual({
      offer: 'Also alert on the 500+ cases that match now',
      text: 'The 500+ cases matching now are recorded as already seen; only cases that appear later will fire.',
    })
  })

  it('says, for a change of a watch keeping its query and key column, that its cases carry on — with nothing to choose', () => {
    const carry = 'Its query and key column stay the same, so its cases carry on'
    expect(existingCases({ matched: 0, newCases: 0, keepsCases: true }, false)).toEqual({ offer: null, text: `${carry}; none matches now. Each new case will fire as it appears.` })
    expect(existingCases({ matched: 3, newCases: 0, keepsCases: true }, false)).toEqual({
      offer: null,
      text: `${carry}: the 3 cases matching now were already seen and will not fire again. Each new case will fire as it appears.`,
    })
    expect(existingCases({ matched: 1, newCases: 1, keepsCases: true }, false)).toEqual({ offer: null, text: `${carry}: the case matching now was not seen yet and will fire on its next run.` })
    // The choice does not count for it: the words stay the same whatever it holds.
    for (const notify of [false, true]) {
      expect(existingCases({ matched: 5, newCases: 2, keepsCases: true }, notify)).toEqual({
        offer: null,
        text: `${carry}: of the 5 cases matching now, 2 not seen yet will fire on its next run; the others were already seen and will not fire again.`,
      })
    }
  })

  it('says, for a change of a watch with another query or key column, which of the cases matching now it has not seen yet', () => {
    expect(existingCases({ matched: 0, newCases: 0, keepsCases: false }, false)).toEqual({ offer: null, text: 'Only cases that appear after you activate it will fire.' })
    // Seen already, every one: nothing to alert on, so nothing to choose.
    expect(existingCases({ matched: 4, newCases: 0, keepsCases: false }, false)).toEqual({
      offer: null,
      text: 'It has already seen the 4 cases matching now: they will not fire again, and only cases that appear later will fire.',
    })
    expect(existingCases({ matched: 1, newCases: 0, keepsCases: false }, false).text).toBe('It has already seen the case matching now: it will not fire again, and only cases that appear later will fire.')
    // None seen yet: as a new watch, but on its next run.
    expect(existingCases({ matched: 3, newCases: 3, keepsCases: false }, false)).toEqual({
      offer: 'Also alert on the 3 cases that match now',
      text: 'The 3 cases matching now are recorded as already seen; only cases that appear later will fire.',
    })
    expect(existingCases({ matched: 3, newCases: 3, keepsCases: false }, true).text).toBe('The 3 cases matching now will fire on its next run, then each new one as it appears.')
    // Some seen, some not: the choice is about those not seen yet.
    expect(existingCases({ matched: 5, newCases: 2, keepsCases: false }, false)).toEqual({
      offer: 'Also alert on the 2 cases matching now that it has not seen yet',
      text: 'Of the 5 cases matching now, 2 not seen yet are recorded as seen, like the others; only cases that appear later will fire.',
    })
    expect(existingCases({ matched: 5, newCases: 1, keepsCases: false }, true)).toEqual({
      offer: 'Also alert on the case matching now that it has not seen yet',
      text: 'Of the 5 cases matching now, 1 not seen yet will fire on its next run; the others were already seen and will not fire again. Then each new one fires as it appears.',
    })
    expect(existingCases({ matched: 5, newCases: 1, keepsCases: false }, false).text).toBe('Of the 5 cases matching now, 1 not seen yet is recorded as seen, like the others; only cases that appear later will fire.')
  })

  it('names the days a report covered as a sentence does', () => {
    expect(periodPhrase('Yesterday', '9 Oct 2026')).toBe('yesterday (9 Oct 2026)')
    expect(periodPhrase('Last 7 days', '3 Oct – 9 Oct 2026')).toBe('the last 7 days (3 Oct – 9 Oct 2026)')
    expect(periodPhrase('Last week', '3 Oct – 9 Oct 2026')).toBe('last week (3 Oct – 9 Oct 2026)')
    // Fixed days are their own label.
    expect(periodPhrase('1 Sep – 30 Sep 2026', '1 Sep – 30 Sep 2026')).toBe('1 Sep – 30 Sep 2026')
    expect(periodPhrase('', '9 Oct 2026')).toBe('9 Oct 2026')
  })

  it('writes the "Edit in chat" question exactly as the assistant expects it', () => {
    expect(editInChatText({ id: 'a1b2', name: 'Holds on line 3' })).toBe('Change my automation "Holds on line 3" (id a1b2): ')
  })
})

describe('an automation’s state', () => {
  it('reads active, paused, failed (with why) and blocked (with why, resuming by itself)', () => {
    expect(automationStatus({ status: 'active' })).toMatchObject({ key: 'active', label: 'Active', tone: 'green' })
    expect(automationStatus({ status: 'paused' })).toMatchObject({ key: 'paused', label: 'Paused', tone: 'neutral' })
    expect(automationStatus({ status: 'failed', statusNote: 'relation "ai.x" does not exist' })).toMatchObject({ key: 'failed', tone: 'red', tip: 'Stopped after failing runs in a row: relation "ai.x" does not exist' })
    // The server's note says it stopped, and how many runs failed: said once, as written.
    const note = 'Stopped after 5 failed runs in a row. The last one: it reads data its creator can no longer see.'
    expect(automationStatus({ status: 'failed', statusNote: note }).tip).toBe(note)
    expect(stoppedText(`  ${note}`)).toBe(note)
    const blocked = automationStatus({ status: 'active', blockedReason: 'no-permission' })
    expect(blocked).toMatchObject({ key: 'blocked', label: 'Blocked', tone: 'amber' })
    expect(blocked.tip).toBe('Its creator may no longer create automations. It resumes by itself once this is put right.')
    // A paused automation is paused whatever its creator's access.
    expect(automationStatus({ status: 'paused', blockedReason: 'creator-inactive' }).key).toBe('paused')
    expect(noNextRunText(blocked)).toBe('Waiting')
    expect(noNextRunText(automationStatus({ status: 'failed' }))).toBe('Stopped')
  })

  it('switches on what is set to run and off what is paused or stopped: pausing one, resuming the other', () => {
    expect(automationSwitch({ status: 'active' })).toMatchObject({ on: true, action: 'pause' })
    // A blocked one is still on — it waits — and its switch says why.
    const blocked = automationSwitch({ status: 'active', blockedReason: 'no-access' })
    expect(blocked).toMatchObject({ on: true, action: 'pause' })
    expect(blocked.tip).toContain('Its creator no longer has the assistant')
    expect(automationSwitch({ status: 'paused' })).toMatchObject({ on: false, action: 'resume' })
    expect(automationSwitch({ status: 'failed' })).toMatchObject({ on: false, action: 'resume' })
  })

  it('shows times in the factory’s clock, whatever the device’s', () => {
    const now = new Date('2026-10-10T09:00:00Z') // 12:00 in Cairo
    const tz = 'Africa/Cairo'
    expect(factoryMoment('2026-10-10T05:00:00Z', tz, now)).toBe('Today, 08:00')
    expect(factoryMoment('2026-10-11T05:00:00Z', tz, now)).toBe('Tomorrow, 08:00')
    expect(factoryMoment('2026-10-09T20:30:00Z', tz, now)).toBe('Yesterday, 23:30')
    // Late in the UTC day is already the next day in Cairo.
    expect(factoryMoment('2026-10-10T22:30:00Z', tz, now)).toBe('Tomorrow, 01:30')
    expect(factoryMoment('2026-10-20T05:00:00Z', tz, now)).toBe('Oct 20, 08:00')
    expect(factoryMoment('2025-12-30T06:00:00Z', tz, now)).toBe('Dec 30, 2025, 08:00')
    expect(factoryMoment(null, tz, now)).toBe('—')
    expect(factoryMoment('nonsense', tz, now)).toBe('—')
    expect(factoryTimestamp('2026-10-10T05:00:05Z', tz)).toBe('Sat, Oct 10, 2026, 08:00:05 factory time')
  })
})

describe('runs and tests in words', () => {
  const run = (over: Partial<AutomationRun>): AutomationRun => ({ id: 'r1', automationId: 'a1', trigger: 'schedule', startedAt: '2026-10-10T05:00:00Z', finishedAt: '2026-10-10T05:00:01Z', ok: true, ...over })

  it('says how a run ended: running, done, skipped while the server was down, failed', () => {
    expect(runOutcome(run({ finishedAt: null, ok: null }))).toEqual({ label: 'Running', tone: 'blue' })
    expect(runOutcome(run({}))).toEqual({ label: 'Done', tone: 'green' })
    expect(runOutcome(run({ ok: false, ms: 0, note: 'Missed: the server was not running at its time, so this run was skipped.' }))).toEqual({ label: 'Skipped', tone: 'neutral' })
    expect(runOutcome(run({ ok: false, ms: 120, error: 'timeout' }))).toEqual({ label: 'Failed', tone: 'red' })
  })

  it('says what a run found and did, and what Run now says once it has run', () => {
    // What was sent counts bell alerts and chat messages, not people: never "told", which reads as people.
    expect(runFigures(run({ matched: 12, fired: 2, notified: 5, followUps: 2 }), 'watch')).toBe('12 matched · 2 new · 5 alerts and messages sent · 2 follow-ups')
    expect(runFigures(run({ matched: 40, fired: 30, notified: 3, digest: true }), 'watch')).toBe('40 matched · 30 new · 3 alerts and messages sent · as one digest')
    expect(runFigures(run({ deliveryId: 'd1', notified: 4 }), 'report')).toBe('Delivered · 4 alerts and messages sent')
    expect(runToast(run({ matched: 1, fired: 1, notified: 1, followUps: 1 }), 'watch')).toBe('Ran: 1 matched · 1 new · 1 alert or message sent · 1 follow-up.')
    expect(runToast(run({ ok: false, error: 'column "x" does not exist' }), 'watch')).toBe('The run failed: column "x" does not exist')
  })

  it('sums a dry run up', () => {
    const t = (over: Partial<AutomationTestResponse>): AutomationTestResponse => ({ ranAt: '2026-10-10T05:00:00Z', ok: true, ...over })
    expect(testSummary(t({ matched: 0, newCases: 0 }), 'watch')).toBe('No case matches now.')
    expect(testSummary(t({ matched: 3, newCases: 3, recipients: 4 }), 'watch')).toBe('3 cases match now; all are new. A run now would tell 4 people.')
    expect(testSummary(t({ matched: 3, newCases: 1, recipients: 1 }), 'watch')).toBe('3 cases match now; 1 is new. A run now would tell 1 person.')
    expect(testSummary(t({ matched: 2, newCases: 0, recipients: 4 }), 'watch')).toBe('2 cases match now; none of them is new.')
    expect(testSummary(t({ ok: false, error: 'Its creator may no longer create automations.' }), 'watch')).toBe('It failed: Its creator may no longer create automations.')
    const section = { title: 's', ok: true, columns: [], rows: [], rowCount: 0, truncated: false, ms: 1 }
    expect(testSummary(t({ sections: [section, { ...section, ok: false }] }), 'report')).toBe('1 of 2 sections failed.')
    expect(testSummary(t({ sections: [section] }), 'report')).toBe('Its 1 section ran.')
  })
})

describe('the edit form', () => {
  it('starts from the definition, a daily report on all seven days when it names none', () => {
    const f = formFromDefinition(watch)
    expect(f).toMatchObject({ name: 'Holds on line 3', notify: true, followUp: true, assignee: { kind: 'column', column: 'inspector_id' }, dueHours: '24', everyMinutes: 5, hoursOn: false })
    // A watch around the clock, every day: the hours switched off, all seven days ticked.
    expect([...f.weekdays].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    const shift = formFromDefinition({ ...watch, watch: { ...watch.watch!, hours: { from: '22:00', to: '06:00' }, weekdays: [1, 2, 3, 4, 5] } })
    expect(shift).toMatchObject({ hoursOn: true, hoursFrom: '22:00', hoursTo: '06:00', weekdays: [1, 2, 3, 4, 5] })
    const r = formFromDefinition({ ...report, schedule: { ...report.schedule!, weekdays: undefined } })
    expect([...r.weekdays].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(r).toMatchObject({ cadence: 'daily', time: '08:00', hasPeriod: true, periodKind: 'yesterday', summary: true })
    // Saved as it was, nothing changed.
    expect(editsFromForm(watch, f)).toEqual({})
    expect(editsFromForm(report, formFromDefinition(report))).toEqual({})
  })

  it('checks what the server checks, the first problem first', () => {
    const f = formFromDefinition(watch)
    expect(checkAutomationForm(f)).toBeNull()
    expect(checkAutomationForm({ ...f, name: '   ' })).toBe('Give it a name.')
    expect(checkAutomationForm({ ...f, name: 'x'.repeat(121) })).toBe('The name takes at most 120 characters.')
    expect(checkAutomationForm({ ...f, description: '' })).toBe('Say in a few words what it does.')
    expect(checkAutomationForm({ ...f, notify: false, followUp: false })).toBe('A watch must tell people, open a follow-up for each case, or both.')
    expect(checkAutomationForm({ ...f, dueHours: '0' })).toMatch(/1 to 720 hours/)
    expect(checkAutomationForm({ ...f, dueHours: '2.5' })).toMatch(/1 to 720 hours/)
    expect(checkAutomationForm({ ...f, assignee: { kind: 'user', userId: '' } })).toBe('Choose who the follow-ups go to.')
    expect(checkAutomationForm({ ...f, everyMinutes: 2 })).toMatch(/every 5 to 1,440 minutes/)
    expect(checkAutomationForm({ ...f, hoursOn: true, hoursFrom: '5:00', hoursTo: '10:00' })).toBe('Choose the hours it runs in, on the 24-hour clock (HH:MM).')
    expect(checkAutomationForm({ ...f, hoursOn: true, hoursFrom: '05:00', hoursTo: '05:00' })).toMatch(/start and end at the same time/)
    // The night is fine: the end before the start crosses midnight.
    expect(checkAutomationForm({ ...f, hoursOn: true, hoursFrom: '22:00', hoursTo: '06:00' })).toBeNull()
    // Switched off, whatever is typed in them is not looked at.
    expect(checkAutomationForm({ ...f, hoursOn: false, hoursFrom: 'x', hoursTo: '' })).toBeNull()
    expect(checkAutomationForm({ ...f, weekdays: [] })).toBe('Tick at least one day it runs.')
    expect(checkAutomationForm({ ...f, recipients: [] })).toBe('Choose at least one person, role or column of people to tell.')
    // A watch that only opens follow-ups needs nobody to tell.
    expect(checkAutomationForm({ ...f, notify: false, recipients: [] })).toBeNull()
    expect(checkAutomationForm({ ...f, channels: { bell: false, chat: false } })).toBe('Choose the bell, the chat, or both.')

    const r = formFromDefinition(report)
    expect(checkAutomationForm(r)).toBeNull()
    expect(checkAutomationForm({ ...r, time: '8am' })).toMatch(/HH:MM/)
    expect(checkAutomationForm({ ...r, weekdays: [] })).toBe('Tick at least one day it runs.')
    expect(checkAutomationForm({ ...r, cadence: 'monthly', monthDay: 31 })).toBe('Choose a day of the month from 1 to 28.')
    expect(checkAutomationForm({ ...r, periodKind: 'last_days', periodDays: '0' })).toMatch(/whole number from 1 to 3,660/)
    expect(checkAutomationForm({ ...r, periodKind: 'fixed', periodFrom: '2026-10-09', periodTo: '2026-10-01' })).toBe('The first day comes after the last.')
    // A report always tells someone.
    expect(checkAutomationForm({ ...r, recipients: [] })).toMatch(/at least one/)
  })

  it('sends only what changed, as the server takes it', () => {
    const f = formFromDefinition(watch)
    expect(editsFromForm(watch, { ...f, name: '  Holds   on line 3 (B)  ', everyMinutes: 15 })).toEqual({ name: 'Holds on line 3 (B)', everyMinutes: 15 })
    expect(editsFromForm(watch, { ...f, followUp: false })).toEqual({ actions: { notify: true, followUp: null } })
    expect(editsFromForm(watch, { ...f, assignee: { kind: 'user', userId: BASEM }, dueHours: '48' })).toEqual({
      actions: { notify: true, followUp: { assignee: { kind: 'user', userId: BASEM }, dueHours: 48 } },
    })
    expect(editsFromForm(watch, { ...f, recipients: [{ kind: 'role', role: 'supervisor' }] })).toEqual({ recipients: [{ kind: 'role', role: 'supervisor' }] })
    expect(editsFromForm(watch, { ...f, channels: { bell: true, chat: true } })).toEqual({ channels: { bell: true, chat: true } })
  })

  it('sends a watch’s hours and days as the server takes them: none for around the clock, none for all seven days', () => {
    const f = formFromDefinition(watch)
    expect(editsFromForm(watch, { ...f, hoursOn: true, hoursFrom: '05:00', hoursTo: '10:00', weekdays: [6, 0, 1, 2, 3, 4] })).toEqual({
      hours: { from: '05:00', to: '10:00' },
      weekdays: [0, 1, 2, 3, 4, 6],
    })
    // Typed hours count only while they are switched on.
    expect(editsFromForm(watch, { ...f, hoursOn: false, hoursFrom: '05:00', hoursTo: '10:00' })).toEqual({})
    const shift: AutomationDraft = { ...watch, watch: { ...watch.watch!, hours: { from: '05:00', to: '10:00' }, weekdays: [6, 0, 1, 2, 3, 4] } }
    const s = formFromDefinition(shift)
    expect(editsFromForm(shift, s)).toEqual({})
    expect(editsFromForm(shift, { ...s, hoursOn: false })).toEqual({ hours: null })
    expect(editsFromForm(shift, { ...s, hoursTo: '12:00' })).toEqual({ hours: { from: '05:00', to: '12:00' } })
    expect(editsFromForm(shift, { ...s, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ weekdays: null })
    expect(editsFromForm(shift, { ...s, weekdays: [1, 2] })).toEqual({ weekdays: [1, 2] })
  })

  it('sends a schedule’s changes with what its cadence needs; all seven days is every day', () => {
    const r = formFromDefinition(report)
    expect(editsFromForm(report, { ...r, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ weekdays: null })
    expect(editsFromForm(report, { ...r, weekdays: [0, 1] })).toEqual({ weekdays: [0, 1] })
    expect(editsFromForm(report, { ...r, cadence: 'weekly', weekday: 0 })).toEqual({ cadence: 'weekly', weekday: 0 })
    expect(editsFromForm(report, { ...r, cadence: 'monthly', monthDay: 1, time: '07:30' })).toEqual({ cadence: 'monthly', time: '07:30', monthDay: 1 })
    expect(editsFromForm(report, { ...r, periodKind: 'last_days', periodDays: '7', summary: false })).toEqual({ period: { kind: 'last_days', days: 7 }, summary: false })
    expect(editsFromForm(report, { ...r, periodKind: 'this_week', periodWeekStart: 'sunday' })).toEqual({ period: { kind: 'this_week', weekStart: 'sunday' } })
    // From weekly back to daily on every day: the cadence alone (the server drops the weekday).
    const weekly: AutomationDraft = { ...report, schedule: { ...report.schedule!, cadence: 'weekly', weekdays: undefined, weekday: 3 } }
    expect(editsFromForm(weekly, { ...formFromDefinition(weekly), cadence: 'daily' })).toEqual({ cadence: 'daily' })
    expect(editsFromForm(weekly, { ...formFromDefinition(weekly), cadence: 'daily', weekdays: [1, 2] })).toEqual({ cadence: 'daily', weekdays: [1, 2] })
  })

  it('reads a period as typed', () => {
    const r = formFromDefinition(report)
    expect(formPeriod({ ...r, periodKind: 'fixed', periodFrom: '2026-09-01', periodTo: '2026-09-30' })).toEqual({ kind: 'fixed', from: '2026-09-01', to: '2026-09-30' })
    expect(formPeriod({ ...r, periodKind: 'last_days', periodDays: 'ten' })).toBeNull()
    expect(formPeriod({ ...r, hasPeriod: false })).toBeNull()
  })

  it('applies changes as the server does: a new cadence takes the old one’s fields away', () => {
    const changed = applyEdits(report, { cadence: 'weekly', weekday: 2, name: 'Weekly rejects' })
    expect(changed.name).toBe('Weekly rejects')
    expect(changed.schedule).toMatchObject({ cadence: 'weekly', weekday: 2, time: '08:00', summary: true })
    expect(changed.schedule?.weekdays).toBeUndefined()
    expect(applyEdits(report, { period: null }).schedule?.period).toBeUndefined()
    expect(applyEdits(watch, { everyMinutes: 30 }).watch?.everyMinutes).toBe(30)
    // A watch's hours and days are set, and taken away as null.
    const timed = applyEdits(watch, { hours: { from: '22:00', to: '06:00' }, weekdays: [1, 2, 3, 4, 5] })
    expect(timed.watch).toMatchObject({ everyMinutes: 5, hours: { from: '22:00', to: '06:00' }, weekdays: [1, 2, 3, 4, 5] })
    expect(watch.watch).not.toHaveProperty('hours')
    const untimed = applyEdits(timed, { hours: null, weekdays: null })
    expect(untimed.watch).not.toHaveProperty('hours')
    expect(untimed.watch).not.toHaveProperty('weekdays')
    const shiftForm = { ...formFromDefinition(watch), hoursOn: true, hoursFrom: '05:00', hoursTo: '10:00', weekdays: [6, 0, 1, 2, 3, 4] as AutomationWeekday[] }
    expect(formFromDefinition(applyEdits(watch, editsFromForm(watch, shiftForm)))).toEqual({ ...shiftForm, weekdays: [0, 1, 2, 3, 4, 6] })
    // The definition it was given is left as it was.
    expect(report.schedule?.weekdays).toEqual([6, 0, 1, 2, 3, 4])
    // Round trip: what the form sends, applied, is what the form shows.
    const f = { ...formFromDefinition(watch), dueHours: '12', everyMinutes: 60 }
    expect(formFromDefinition(applyEdits(watch, editsFromForm(watch, f)))).toEqual(f)
    expect(hasEdits({})).toBe(false)
    expect(hasEdits(null)).toBe(false)
    expect(hasEdits({ summary: false })).toBe(true)
  })

  it('knows the columns a watch is known to return, and offers its interval among the presets', () => {
    expect(knownWatchColumns(watch)).toEqual(['sample_id', 'session_id', 'machine', 'inspector_id'])
    expect(knownWatchColumns(watch, ['sample_id', 'line'])).toEqual(['sample_id', 'line', 'session_id', 'machine', 'inspector_id'])
    expect(intervalOptions(7)).toContain(7)
    expect(intervalOptions(5).filter((n) => n === 5)).toHaveLength(1)
  })
})

describe('the card in the cached conversation', () => {
  it('takes the card as it stands now into every answer that holds it, and leaves the rest as they were', () => {
    const proposed: AiAutomationPart = { type: 'automation', proposalId: 'p1', ok: true, state: 'proposed', draft: watch }
    const activated: AiAutomationPart = { ...proposed, state: 'activated', automationId: 'a1' }
    const old: AiMessagesResponse = {
      conversation: { id: 'c1', title: 'Holds', createdAt: '2026-10-10T05:00:00Z', lastMessageAt: '2026-10-10T05:00:00Z', pinnedAt: null, groupId: null, archivedAt: null },
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Watch holds' }], createdAt: '2026-10-10T05:00:00Z' },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Here it is.' }, proposed], createdAt: '2026-10-10T05:00:05Z' },
      ],
    }
    const next = replaceAutomationPart(old, activated)
    expect(next?.messages[1].parts[1]).toEqual(activated)
    expect(next?.messages[0]).toBe(old.messages[0])
    // Another proposal's card changes nothing at all.
    expect(replaceAutomationPart(old, { ...activated, proposalId: 'p9' })).toBe(old)
    expect(replaceAutomationPart(undefined, activated)).toBeUndefined()
  })

  it('names the proposal a newer version replaces only when the server accepted it', () => {
    const revision: AiAutomationPart = { type: 'automation', proposalId: 'p2', ok: true, state: 'proposed', draft: { ...watch, revisesProposalId: 'p1' } }
    expect(revisedProposalId(revision)).toBe('p1')
    // Refused: the server marked nothing, so neither does the thread.
    expect(revisedProposalId({ ...revision, ok: false, error: 'revisesProposalId: no such proposal' })).toBeNull()
    expect(revisedProposalId({ ...revision, draft: watch })).toBeNull()
    expect(revisedProposalId({ ...revision, draft: undefined })).toBeNull()
    // A draft naming itself replaces nothing.
    expect(revisedProposalId({ ...revision, draft: { ...watch, revisesProposalId: 'p2' } })).toBeNull()
  })

  it('marks the card a newer version replaces, wherever it is, while it is still to be decided', () => {
    const first: AiAutomationPart = { type: 'automation', proposalId: 'p1', ok: true, state: 'proposed', draft: watch }
    const old: AiMessagesResponse = {
      conversation: { id: 'c1', title: 'Holds', createdAt: '2026-10-10T05:00:00Z', lastMessageAt: '2026-10-10T05:00:00Z', pinnedAt: null, groupId: null, archivedAt: null },
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Watch holds' }], createdAt: '2026-10-10T05:00:00Z' },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Here it is.' }, first], createdAt: '2026-10-10T05:00:05Z' },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Make it every 10 minutes' }], createdAt: '2026-10-10T05:01:00Z' },
      ],
    }
    const next = supersedeAutomationPart(old, 'p1')
    expect(next?.messages[1].parts[1]).toEqual({ ...first, state: 'superseded' })
    expect(next?.messages[1].parts[0]).toBe(old.messages[1].parts[0])
    expect(next?.messages[0]).toBe(old.messages[0])
    expect(next?.messages[2]).toBe(old.messages[2])
    // What was cached is left as it was.
    expect(first.state).toBe('proposed')
    // Already replaced, decided, refused, or another proposal's: nothing changes at all.
    expect(supersedeAutomationPart(next, 'p1')).toBe(next)
    for (const card of [{ ...first, state: 'activated' as const, automationId: 'a1' }, { ...first, state: 'discarded' as const }, { ...first, ok: false, error: 'not a column' }]) {
      const held: AiMessagesResponse = { ...old, messages: [{ ...old.messages[1], parts: [card] }] }
      expect(supersedeAutomationPart(held, 'p1')).toBe(held)
    }
    expect(supersedeAutomationPart(old, 'p9')).toBe(old)
    expect(supersedeAutomationPart(undefined, 'p1')).toBeUndefined()
    // An answer's own parts the same way: an untouched list is the same list.
    const parts = [{ type: 'text' as const, text: 'Here it is.' }, first]
    expect(supersedeParts(parts, 'p1')).toEqual([parts[0], { ...first, state: 'superseded' }])
    expect(supersedeParts(parts, 'p9')).toBe(parts)
  })

  it('names the replaced state on the card', () => {
    expect(PROPOSAL_STATE_LABEL.superseded).toBe('Replaced')
    expect(PROPOSAL_STATE_TONE.superseded).toBe('neutral')
  })

  it('is typed against the automation the page shows, too', () => {
    const a = { id: 'a1', name: 'Holds' } satisfies Pick<Automation, 'id' | 'name'>
    expect(editInChatText(a)).toBe('Change my automation "Holds" (id a1): ')
  })
})

describe('a schedule that sends a saved report', () => {
  const linked: AutomationDraft = {
    ...report,
    schedule: { cadence: 'daily', time: '07:30', sections: [], summary: false, report: { reportId: 'r1', inputs: { orders: ['20332', '20378'] } } },
  }
  const inputs = [
    { name: 'orders', label: 'Orders', kind: 'list' as const, required: true },
    { name: 'week', label: 'Planning week', kind: 'number' as const, required: true, dynamicDefault: 'this_week' as const },
    { name: 'exclude', label: 'Leave out these orders', kind: 'list' as const, required: false },
  ]

  it('says each value it gives, and what one left empty takes on the day', () => {
    expect(linkedValuesLines(inputs, { orders: ['20332', '20378'] })).toEqual(['Orders: 20332, 20378', "Planning week: this week's, on the day it runs", 'Leave out these orders: none'])
    expect(linkedValuesLines(inputs, { orders: ['1'], week: 26, exclude: [] })).toEqual(['Orders: 1', 'Planning week: 26', 'Leave out these orders: none'])
  })

  it('changes its values on the form, and only when they change', () => {
    const f = formFromDefinition(linked)
    expect(f.reportInputs).toEqual({ orders: '20332, 20378' })
    expect(editsFromForm(linked, f)).toEqual({})
    expect(editsFromForm(linked, { ...f, reportInputs: { orders: '20332, 20378', week: ' ' } })).toEqual({})
    expect(editsFromForm(linked, { ...f, reportInputs: { orders: '20332', week: '26' } })).toEqual({ reportInputs: { orders: '20332', week: '26' } })
    // On the card before it is activated: the values as typed, until the server reads them.
    expect(applyEdits(linked, { reportInputs: { orders: '20332' } }).schedule!.report).toEqual({ reportId: 'r1', inputs: { orders: '20332' } })
    // A schedule with sections of its own has no values to give.
    expect(formFromDefinition(report).reportInputs).toBeNull()
  })
})

describe('a saved report in the summary sentence', () => {
  it('names the report it sends', () => {
    const d = { ...report, schedule: { ...report.schedule!, period: undefined, sections: [], report: { reportId: 'r1', inputs: {} } }, recipients: [] }
    expect(automationSummary({ ...d, linkedReport: { title: 'Order tracking' } })).toBe('Saturday to Thursday at 08:00 (factory time) it runs the saved report “Order tracking”, adds a short summary written by the assistant, and sends the result to nobody on the bell and the chat.')
  })
})
