import { describe, expect, it } from 'vitest'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiNoticeDraft, AiNoticePart } from '@qc/shared/noticeAssistant'
import { ApiError } from '@/lib/api'
import {
  NOTICE_ACTION_BUTTON,
  NOTICE_ACTION_TITLE,
  NOTICE_APPLIED,
  appliedToast,
  attachmentsNote,
  dayText,
  daysText,
  hasOpenNoticeCard,
  matchModeText,
  noticeChanges,
  noticePartOf,
  noticeStateLabel,
  noticeTitle,
  placeWords,
  previewNotice,
  reachText,
  reachesNobody,
  replaceNoticePart,
  staleText,
} from './noticeProposal'

const draft = (over: Partial<AiNoticeDraft> = {}): AiNoticeDraft => ({
  title: 'Check the coating thickness',
  body: 'Measure every coil at the start of the shift.',
  severity: 'warning',
  requiresAck: true,
  matchMode: 'all',
  validFrom: '2026-10-10',
  validTo: null,
  targets: [{ kind: 'machine', value: 'RF-03', label: 'RF-03 — Roll former 3' }],
  ...over,
})

const card = (over: Partial<AiNoticePart> = {}): AiNoticePart => ({ type: 'notice', proposalId: 'n1', ok: true, action: 'create', draft: draft(), state: 'proposed', ...over })

describe('what a notice card does, and how it stands', () => {
  it('names each action, its button and what it did', () => {
    expect(NOTICE_ACTION_TITLE).toEqual({ create: 'New notice', update: 'Change to a notice', withdraw: 'Withdraw notice', delete: 'Delete notice' })
    expect(NOTICE_ACTION_BUTTON).toEqual({ create: 'Publish', update: 'Apply changes', withdraw: 'Withdraw', delete: 'Delete' })
    expect(NOTICE_APPLIED).toEqual({ create: 'Published', update: 'Changed', withdraw: 'Withdrawn', delete: 'Deleted' })
  })

  it('says how the card stands, in the words of its action while it waits', () => {
    expect(noticeStateLabel('create', 'proposed')).toBe('Not published yet')
    expect(noticeStateLabel('update', 'proposed')).toBe('Not applied yet')
    expect(noticeStateLabel('withdraw', 'proposed')).toBe('Not withdrawn yet')
    expect(noticeStateLabel('delete', 'proposed')).toBe('Not deleted yet')
    expect(noticeStateLabel('create', 'applied')).toBe('Published')
    expect(noticeStateLabel('delete', 'applied')).toBe('Deleted')
    expect(noticeStateLabel('update', 'discarded')).toBe('Discarded')
    expect(noticeStateLabel('create', 'superseded')).toBe('Replaced')
    expect(noticeStateLabel('withdraw', 'stale')).toBe('Out of date')
  })

  it('says why a card out of date can no longer be applied', () => {
    for (const action of ['update', 'withdraw', 'delete'] as const) expect(staleText(action)).toBe('The notice changed since; ask the assistant again.')
    expect(staleText('create')).toBe('An earlier version was published meanwhile; ask the assistant to change that notice instead.')
  })

  it('says what the button did, naming the notice, and that it is in the audit log', () => {
    expect(appliedToast('create', 'Coating')).toBe('“Coating” is published. The change is in the audit log.')
    expect(appliedToast('update', 'Coating')).toBe('“Coating” is changed. The change is in the audit log.')
    expect(appliedToast('withdraw', 'Coating')).toBe('“Coating” is withdrawn: it stops showing at once. The change is in the audit log.')
    expect(appliedToast('delete', ' ')).toBe('“The notice” is deleted. The change is in the audit log.')
  })

  it('names the notice as it will be, else as it is', () => {
    expect(noticeTitle(card())).toBe('Check the coating thickness')
    expect(noticeTitle(card({ action: 'withdraw', draft: undefined, before: draft({ title: ' Old title ' }) }))).toBe('Old title')
    expect(noticeTitle(card({ draft: undefined }))).toBe('')
  })
})

describe('days, targets and reach', () => {
  it('writes the days a notice shows, each a factory day wherever the device is', () => {
    expect(daysText(draft())).toBe(`From ${dayText('2026-10-10')} until withdrawn`)
    expect(daysText(draft({ validTo: '2026-10-10' }))).toBe(`${dayText('2026-10-10')} only`)
    expect(daysText(draft({ validTo: '2026-10-20' }))).toBe(`${dayText('2026-10-10')} – ${dayText('2026-10-20')}`)
    // Read as the local day, not UTC midnight (which is the day before west of Greenwich).
    expect(dayText('2026-10-10')).toMatch(/Oct 10/)
  })

  it('says how several targets combine; nothing with one or none', () => {
    expect(matchModeText(draft())).toBeNull()
    expect(matchModeText(draft({ targets: [] }))).toBeNull()
    const two = [
      { kind: 'machine' as const, value: 'RF-03', label: 'RF-03' },
      { kind: 'machine' as const, value: 'RF-04', label: 'RF-04' },
    ]
    expect(matchModeText(draft({ targets: two }))).toBe('Any one of these.')
    expect(matchModeText(draft({ targets: [two[0], { kind: 'order-number', value: '4711', label: '4711' }] }))).toBe('Every kind must hold at once; any one value of each kind.')
    expect(matchModeText(draft({ targets: two, matchMode: 'any' }))).toBe('One of these is enough.')
  })

  it('names the places a notice is bound to, in the app’s order, people left out', () => {
    expect(
      placeWords([
        { kind: 'order-number', value: '4711', label: '4711' },
        { kind: 'user', value: 'u1', label: 'Mona' },
        { kind: 'machine', value: 'RF-03', label: 'RF-03' },
        { kind: 'order-line', value: 'l1', label: '4711/1' },
        { kind: 'machine', value: 'RF-04', label: 'RF-04' },
      ]),
    ).toBe('machine/order/order line')
    expect(placeWords([{ kind: 'role', value: 'inspector', label: 'Inspector' }])).toBe('place')
  })

  it('says whom it reaches: everyone with a count, people by number, or whoever works at its place', () => {
    const roles = draft({ targets: [{ kind: 'role', value: 'inspector', label: 'Inspector' }] })
    expect(reachText({ everyone: true, people: 42, placeBound: false }, draft({ targets: [] }))).toBe('Everyone (42 people)')
    expect(reachText({ everyone: true, people: null, placeBound: false }, draft({ targets: [] }))).toBe('Everyone')
    expect(reachText({ everyone: false, people: 1, placeBound: false }, roles)).toBe('1 person')
    expect(reachText({ everyone: false, people: 1250, placeBound: false }, roles)).toBe('1,250 people')
    expect(reachText({ everyone: false, people: null, placeBound: true }, draft())).toBe('Shown at the machine to whoever works there')
    const both = [
      { kind: 'machine' as const, value: 'RF-03', label: 'RF-03' },
      { kind: 'user' as const, value: 'u1', label: 'Mona' },
      { kind: 'user' as const, value: 'u2', label: 'Basem' },
    ]
    // People next to a place: one more way to reach someone, or a condition on those people.
    expect(reachText({ everyone: false, people: 2, placeBound: true }, draft({ targets: both, matchMode: 'any' }))).toBe('2 people, and whoever works at the machine')
    expect(reachText({ everyone: false, people: 2, placeBound: true }, draft({ targets: both, matchMode: 'all' }))).toBe('Up to 2 people, when they work at the machine')
  })

  it('warns when it reaches nobody — but a place still reaches whoever works there', () => {
    const roles = draft({ targets: [{ kind: 'role', value: 'viewer', label: 'Viewer' }] })
    expect(reachesNobody({ everyone: false, people: 0, placeBound: false }, roles)).toBe(true)
    expect(reachText({ everyone: false, people: 0, placeBound: false }, roles)).toBe('Nobody: no active account matches')
    expect(reachesNobody({ everyone: false, people: 0, placeBound: true }, draft({ matchMode: 'all' }))).toBe(true)
    expect(reachesNobody({ everyone: false, people: 0, placeBound: true }, draft({ matchMode: 'any' }))).toBe(false)
    expect(reachText({ everyone: false, people: 0, placeBound: true }, draft({ matchMode: 'any' }))).toBe('Shown at the machine to whoever works there')
    expect(reachesNobody({ everyone: true, people: 0, placeBound: false }, roles)).toBe(false)
    expect(reachesNobody({ everyone: false, people: null, placeBound: true }, draft())).toBe(false)
  })
})

describe('what a change changes', () => {
  it('lists nothing for the same notice, and a label read again differently is no change', () => {
    expect(noticeChanges(draft(), draft())).toEqual([])
    expect(noticeChanges(draft(), draft({ targets: [{ kind: 'machine', value: 'RF-03', label: 'Roll former 3' }] }))).toEqual([])
    // Photos and files are never part of it: a change keeps them.
    expect(noticeChanges(draft({ attachments: 2 }), draft({ attachments: 0 }))).toEqual([])
  })

  it('lists each changed field before → after, in the order the notice reads', () => {
    const after = draft({ title: 'Coating thickness, every coil', severity: 'critical', requiresAck: false, validFrom: '2026-10-11', validTo: '2026-10-20' })
    expect(noticeChanges(draft(), after)).toEqual([
      { field: 'title', label: 'Title', before: 'Check the coating thickness', after: 'Coating thickness, every coil' },
      { field: 'severity', label: 'Severity', before: 'Warning', after: 'Critical' },
      { field: 'requiresAck', label: 'Acknowledgement', before: 'Required', after: 'Not required' },
      { field: 'validFrom', label: 'Shown from', before: dayText('2026-10-10'), after: dayText('2026-10-11') },
      { field: 'validTo', label: 'Shown until', before: 'Until withdrawn', after: dayText('2026-10-20') },
    ])
    expect(noticeChanges(draft(), draft({ body: '' }))).toEqual([{ field: 'body', label: 'Text', before: 'Measure every coil at the start of the shift.', after: '' }])
  })

  it('says which targets are added and which removed, and how they combine only where several do', () => {
    const rf04 = { kind: 'machine' as const, value: 'RF-04', label: 'RF-04' }
    const order = { kind: 'order-number' as const, value: '4711', label: '4711' }
    const [change] = noticeChanges(draft(), draft({ targets: [rf04, order] }))
    expect(change).toEqual({
      field: 'targets',
      label: 'Aimed at',
      before: 'Machine RF-03 — Roll former 3',
      after: 'Machine RF-04, Order number 4711',
      added: [rf04, order],
      removed: [draft().targets[0]],
    })
    expect(noticeChanges(draft(), draft({ targets: [] }))[0]).toMatchObject({ after: 'Everyone, everywhere', added: [], removed: draft().targets })
    // One target either side: how they combine changes nothing.
    expect(noticeChanges(draft(), draft({ matchMode: 'any' }))).toEqual([])
    const several = draft({ targets: [draft().targets[0], order] })
    expect(noticeChanges(several, { ...several, matchMode: 'any' })).toEqual([{ field: 'matchMode', label: 'Targets combine', before: 'Every kind at once', after: 'One of them is enough' }])
  })

  it('says what becomes of the photos and files the notice carries', () => {
    expect(attachmentsNote('update', 3)).toBe('Photos and files stay (3); add more on the Notices page.')
    expect(attachmentsNote('withdraw', 1)).toBe('Its photos and files (1) stay with it on the Notices page.')
    expect(attachmentsNote('delete', 2)).toBe('Its photos and files (2) go with it.')
    expect(attachmentsNote('update', 0)).toBeNull()
    expect(attachmentsNote('update', undefined)).toBeNull()
    expect(attachmentsNote('create', 4)).toBeNull()
  })

  it('makes a draft a notice for the reader’s view: no photos, files or author of its own', () => {
    const n = previewNotice(draft({ attachments: 3 }))
    expect(n).toMatchObject({ title: 'Check the coating thickness', severity: 'warning', requiresAck: true, matchMode: 'all', validFrom: '2026-10-10', validTo: null, imageIds: [], files: [], createdByName: '' })
    expect(n.targets).toEqual(draft().targets)
  })
})

describe('the card in the cached conversation', () => {
  const conversation = (parts: AiMessagesResponse['messages'][number]['parts']): AiMessagesResponse => ({
    conversation: { id: 'c1', title: 'Notices', createdAt: '2026-10-10T05:00:00Z', lastMessageAt: '2026-10-10T05:00:00Z' },
    messages: [
      { id: 'q', role: 'user', parts: [{ type: 'text', text: 'Warn RF-03 about the coating.' }], createdAt: '2026-10-10T05:00:00Z' },
      { id: 'a', role: 'assistant', parts, createdAt: '2026-10-10T05:00:05Z' },
    ],
  })

  it('puts the card as it stands now wherever it is, and leaves an untouched list the same object', () => {
    const old = conversation([{ type: 'text', text: 'Here it is.' }, card()])
    const applied = card({ state: 'applied', noticeId: 'nt1', appliedAt: '2026-10-10T05:01:00Z' })
    const next = replaceNoticePart(old, applied)
    expect(next?.messages[1].parts[1]).toEqual(applied)
    expect(next?.messages[0]).toBe(old.messages[0])
    expect(replaceNoticePart(old, card({ proposalId: 'other', state: 'applied' }))).toBe(old)
    expect(replaceNoticePart(undefined, applied)).toBeUndefined()
  })

  it('knows when an earlier card still waits for its button, so a newer one may have replaced it', () => {
    expect(hasOpenNoticeCard(conversation([card()]), 'n2')).toBe(true)
    expect(hasOpenNoticeCard(conversation([card()]), 'n1')).toBe(false)
    expect(hasOpenNoticeCard(conversation([card({ state: 'applied' })]), 'n2')).toBe(false)
    expect(hasOpenNoticeCard(conversation([card({ ok: false, error: 'title: blank' })]), 'n2')).toBe(false)
    expect(hasOpenNoticeCard(undefined, 'n2')).toBe(false)
  })

  it('reads the card a refusal carries, only when it is this card', () => {
    const stale = card({ state: 'stale' })
    expect(noticePartOf(new ApiError(409, 'conflict', 'The notice changed since.', { part: stale }), 'n1')).toEqual(stale)
    expect(noticePartOf(new ApiError(409, 'conflict', 'The notice changed since.', { part: stale }), 'n2')).toBeNull()
    expect(noticePartOf(new ApiError(409, 'conflict', 'Already applied.'), 'n1')).toBeNull()
    expect(noticePartOf(new ApiError(400, 'validation', 'Bad.', [{ path: '', message: 'x' }]), 'n1')).toBeNull()
    expect(noticePartOf(new Error('Network'), 'n1')).toBeNull()
  })
})
