// ============================================================================
// §21 — automations in words and checks: what kind one is, when it runs and
// whom it tells, in plain words; its state on the Automations page (active,
// paused, failed, or blocked — and why); times in the factory's clock; the
// edit form's fields, whether they can be saved and the AutomationEdits they
// come to; and the proposal card's state in the cached conversation (decided,
// or replaced by a newer version, §22). Pure, so it is tested without a
// browser. Never a cost: what an automation costs is the AI owner's to see on
// the assistant's settings page, nowhere else.
// ============================================================================

import { AI_REPORT_MAX_DAYS, describeAiPeriod, type AiMessagesResponse, type AiReportPeriod, type AiWeekStart } from '@qc/shared/ai'
import {
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_MAX_EVERY_MINUTES,
  AUTOMATION_MAX_RECIPIENTS,
  AUTOMATION_MIN_EVERY_MINUTES,
  AUTOMATION_NAME_MAX,
  FOLLOW_UP_MAX_DUE_HOURS,
  FOLLOW_UP_MIN_DUE_HOURS,
  describeSchedule,
  describeWatchTiming,
  isAutomationTime,
  isAutomationWeekday,
  isEveryDay,
  templatePlaceholders,
  weekdayName,
  type AiAutomationPart,
  type Automation,
  type AutomationActions,
  type AutomationAssignee,
  type AutomationAssigneeView,
  type AutomationBacktest,
  type AutomationBlockedReason,
  type AutomationCadence,
  type AutomationChannels,
  type AutomationDraft,
  type AutomationEdits,
  type AutomationHours,
  type AutomationKind,
  type AutomationProposalState,
  type AutomationRecipient,
  type AutomationRecipientView,
  type AutomationRun,
  type AutomationLinkedReport,
  type AutomationScheduleSpec,
  type AutomationTestResponse,
  type AutomationWatchSpec,
  type AutomationWeekday,
} from '@qc/shared/automation'
import type { Role } from '@qc/shared/types'
import type { AiReportInput, AiReportInputValues } from '@qc/shared/aiReportInputs'
import type { BadgeTone } from '@/components/ui'
import { checkAiDayRange } from '@/components/ai/reports'
import { dayInTimeZone } from '@/lib/utils'

// ---- Kind, channels, people ------------------------------------------------------------

export const KIND_LABEL: Record<AutomationKind, string> = { watch: 'Watch', report: 'Scheduled report' }
export const KIND_TONE: Record<AutomationKind, BadgeTone> = { watch: 'blue', report: 'violet' }
/** What each kind does, for a badge's tooltip. */
export const KIND_TIP: Record<AutomationKind, string> = {
  watch: 'Runs its query every few minutes, without the assistant, and acts once on each new case it finds',
  report: 'Runs its sections at a set hour, factory time, and sends the result',
}

/** Where people are told: "The bell and the chat". */
export function channelsText(c: AutomationChannels): string {
  if (c.bell && c.chat) return 'The bell and the chat'
  if (c.bell) return 'The bell'
  if (c.chat) return 'The chat'
  return 'Nowhere'
}

/** A whole role as a recipient reads, as the server words it. */
export const ROLE_RECIPIENT_LABEL: Record<Role, string> = {
  viewer: 'Every viewer',
  inspector: 'Every inspector',
  supervisor: 'Every supervisor',
  admin: 'Every administrator',
}

/** A role as a heading: "Supervisor". */
export const roleName = (role: string): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'No role')

/** Someone who can be told, as the people list gives them. */
export interface AutomationPerson {
  id: string
  name: string
}

/**
 * Recipients with names to read, for a definition changed on screen: a person
 * by the name the people list (active accounts) gives, else the name the
 * server gave before (`known`), marked invalid either way when they are not
 * among the active accounts; a column the result does not have (when the
 * columns are known) is marked invalid too.
 */
export function recipientViews(
  recipients: readonly AutomationRecipient[],
  people: ReadonlyMap<string, AutomationPerson> | null,
  known: readonly AutomationRecipientView[] = [],
  columns: readonly string[] | null = null,
): AutomationRecipientView[] {
  return recipients.map((r) => {
    if (r.kind === 'role') return { ...r, label: ROLE_RECIPIENT_LABEL[r.role] ?? roleName(r.role) }
    if (r.kind === 'column') {
      const view: AutomationRecipientView = { ...r, label: `People in "${r.column}"` }
      if (columns && !columns.includes(r.column)) view.invalid = true
      return view
    }
    const before = known.find((k) => k.kind === 'user' && k.userId === r.userId)
    const person = people?.get(r.userId)
    const view: AutomationRecipientView = { ...r, label: person?.name ?? before?.label ?? 'Unknown account' }
    // Without the list, the server's word stands; with it, only an active account is a valid one.
    if (people ? !person : before?.invalid) view.invalid = true
    return view
  })
}

/** A follow-up's assignee with a name to read; the same rules as recipientViews. */
export function assigneeView(
  a: AutomationAssignee,
  people: ReadonlyMap<string, AutomationPerson> | null,
  creatorName: string,
  known?: AutomationAssigneeView,
  columns: readonly string[] | null = null,
): AutomationAssigneeView {
  if (a.kind === 'creator') return { ...a, label: `${creatorName} (creator)` }
  if (a.kind === 'column') {
    const view: AutomationAssigneeView = { ...a, label: `The person in "${a.column}"` }
    if (columns && !columns.includes(a.column)) view.invalid = true
    return view
  }
  const before = known?.kind === 'user' && known.userId === a.userId ? known : undefined
  const person = people?.get(a.userId)
  const view: AutomationAssigneeView = { ...a, label: person?.name ?? before?.label ?? 'Unknown account' }
  if (people ? !person : before?.invalid) view.invalid = true
  return view
}

const lowerFirst = (s: string) => s.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())

/**
 * A recipient as a sentence names it, where a chip's label would read wrong
 * mid-sentence: "every supervisor", "the people in "inspector_id"", a person
 * by their name.
 */
export function recipientPhrase(r: AutomationRecipientView): string {
  if (r.kind === 'role') return lowerFirst(ROLE_RECIPIENT_LABEL[r.role] ?? roleName(r.role))
  if (r.kind === 'column') return `the people in "${r.column}"`
  return r.label
}

/** A follow-up's assignee as a sentence names them: "the person in "inspector_id"", a person by their name. */
export function assigneePhrase(a: AutomationAssigneeView): string {
  return a.kind === 'column' ? `the person in "${a.column}"` : a.label
}

/** A list read out: "A", "A and B", "A, B and C", "A, B, C and 2 more". */
export function listWords(items: readonly string[], max = 3): string {
  if (items.length === 0) return 'nobody'
  if (items.length === 1) return items[0]
  const shown = items.slice(0, max)
  const rest = items.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

// ---- When it runs, what it does ------------------------------------------------------

/** "36 hours" reads as "1 day 12 hours"; "48 hours" as "2 days". */
export function describeDueHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '—'
  const h = Math.round(hours)
  const days = Math.floor(h / 24)
  const rest = h % 24
  const hoursText = (n: number) => `${n} hour${n === 1 ? '' : 's'}`
  if (days === 0) return hoursText(rest)
  const daysText = `${days} day${days === 1 ? '' : 's'}`
  return rest === 0 ? daysText : `${daysText} ${hoursText(rest)}`
}

/** When it runs, in words: a watch's interval, hours and days; a report's schedule (factory time). */
export function whenText(def: {
  kind: AutomationKind
  watch?: Pick<AutomationWatchSpec, 'everyMinutes' | 'hours' | 'weekdays'>
  schedule?: Pick<AutomationScheduleSpec, 'cadence' | 'time' | 'weekdays' | 'weekday' | 'monthDay'>
}): string {
  if (def.kind === 'watch') return def.watch ? describeWatchTiming(def.watch) : '—'
  return def.schedule ? describeSchedule(def.schedule) : '—'
}

/** What a follow-up action does: "Opens a follow-up for Mona Adel, due 1 day after the case" (the assignee as assigneePhrase names them). */
export function followUpText(dueHours: number, assignee: string): string {
  return `Opens a follow-up for ${assignee}, due ${describeDueHours(dueHours)} after the case`
}

/** The "Needs review" word a watch's follow-ups bring, when its cases name an inspection session. */
export const NEEDS_REVIEW_TEXT = 'Marks the session "Needs review" until the follow-up is closed'

export const needsReview = (watch: Pick<AutomationWatchSpec, 'sessionColumn'> | undefined, actions: AutomationActions): boolean => !!watch?.sessionColumn && !!actions.followUp

/** A definition as the card and the page read it out. */
export interface SummaryInput {
  kind: AutomationKind
  watch?: AutomationWatchSpec
  schedule?: AutomationScheduleSpec
  recipients: readonly AutomationRecipientView[]
  channels: AutomationChannels
  actions: AutomationActions
  assignee?: AutomationAssigneeView
  /** A report sending a saved report: its title. */
  linkedReport?: Pick<AutomationLinkedReport, 'title'>
}

/**
 * An automation in one or two plain sentences: when it runs and what it does.
 * "Every 5 minutes it looks for new cases. Each new case is told to every
 * supervisor on the bell, and gets a follow-up for Mona Adel, due 1 day
 * after the case." — or, kept to some hours and days, "Every 5 minutes from
 * 05:00 to 10:00, Saturday to Thursday (factory time), it looks for new
 * cases." Recipients and the assignee as a sentence names them.
 */
export function automationSummary(d: SummaryInput): string {
  const who = listWords(d.recipients.map(recipientPhrase))
  const where = channelsText(d.channels).toLowerCase()
  if (d.kind === 'report') {
    const s = d.schedule
    if (!s) return 'A scheduled report.'
    const n = s.sections.length
    // A saved report by its title, as it stands at each run; or its own sections.
    const sections = s.report ? `the saved report “${d.linkedReport?.title ?? 'it sends'}”` : `${n} section${n === 1 ? '' : 's'}`
    const over = s.period ? ` over ${describeAiPeriod(s.period).replace(/^[A-Z]/, (c) => c.toLowerCase())}` : ''
    const summary = s.summary ? ', adds a short summary written by the assistant,' : ''
    return `${describeSchedule(s)} (factory time) it runs ${sections}${over}${summary} and sends the result to ${who} on ${where}.`
  }
  const w = d.watch
  // Kept to some hours or days, the timing is a clause of its own.
  const limited = !!w && (!!w.hours || !isEveryDay(w.weekdays))
  const start = !w ? 'It looks for new cases.' : limited ? `${describeWatchTiming(w)}${w.hours ? ' (factory time)' : ''}, it looks for new cases.` : `${describeWatchTiming(w)} it looks for new cases.`
  const f = d.actions.followUp
  const follow = f ? `gets a follow-up for ${d.assignee ? assigneePhrase(d.assignee) : 'its assignee'}, due ${describeDueHours(f.dueHours)} after the case` : ''
  if (d.actions.notify && f) return `${start} Each new case is told to ${who} on ${where}, and ${follow}.`
  if (d.actions.notify) return `${start} Each new case is told to ${who} on ${where}.`
  if (f) return `${start} Each new case ${follow}.`
  return start
}

// ---- A proposal on its card --------------------------------------------------------------

export const PROPOSAL_STATE_LABEL: Record<AutomationProposalState, string> = { proposed: 'Not active yet', activated: 'Active', discarded: 'Discarded', superseded: 'Replaced' }
export const PROPOSAL_STATE_TONE: Record<AutomationProposalState, BadgeTone> = { proposed: 'amber', activated: 'green', discarded: 'neutral', superseded: 'neutral' }

/** What the card's trial run found (its time is said over it: a card can be read days later). */
export function matchedText(matched: number, truncated: boolean): string {
  if (matched === 0) return 'No case matched.'
  const n = truncated ? `${matched.toLocaleString('en-US')}+` : matched.toLocaleString('en-US')
  return `${n} ${matched === 1 && !truncated ? 'case' : 'cases'} matched.`
}

/**
 * The days a report's run covered, as a sentence names them: "yesterday
 * (9 Oct 2026)", "the last 7 days (3 Oct – 9 Oct 2026)", "1 Sep – 30 Sep 2026".
 */
export function periodPhrase(label: string, days: string): string {
  const l = label.trim()
  if (!l || l === days) return days
  const lower = lowerFirst(l)
  return `${/^last \d/.test(lower) ? `the ${lower}` : lower} (${days})`
}

/** "the case", "the 3 cases", "the 500+ cases" (more than the run looks at). */
const theCases = (n: number, truncated = false): string =>
  n === 1 && !truncated ? 'the case' : `the ${n.toLocaleString('en-US')}${truncated ? '+' : ''} cases`

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** What a watch's proposal card says of the cases matching now. */
export interface ExistingCasesView {
  /** The "Also alert on…" choice; null when there is nothing it would change. */
  offer: string | null
  /** What becomes of the cases matching now once it is activated, as the choice stands. */
  text: string
}

/**
 * What becomes of the cases a watch's trial run found matching now once it
 * is activated. A new watch: they are recorded as already seen, unless the
 * person asks to be alerted on them too. A change of one (`newCases`, the
 * cases its automation has not seen yet, is known): those it has seen never
 * fire again; keeping its query and key column (`keepsCases`), its cases
 * carry on — those not seen yet fire on its next run, and there is nothing
 * to choose; otherwise those not seen yet are recorded as seen, unless the
 * person asks to be alerted on them.
 */
export function existingCases(bt: Pick<AutomationBacktest, 'matched' | 'truncated' | 'newCases' | 'keepsCases'>, notifyExisting: boolean): ExistingCasesView {
  const matched = bt.matched ?? 0
  const truncated = !!bt.truncated
  const all = theCases(matched, truncated)
  const later = 'only cases that appear later will fire.'
  if (bt.newCases === undefined) {
    if (matched === 0) return { offer: null, text: 'Only cases that appear after you activate it will fire.' }
    return {
      offer: `Also alert on ${all} that match now`,
      text: notifyExisting
        ? `${upperFirst(all)} matching now will fire on its first run, then each new one as it appears.`
        : `${upperFirst(all)} matching now ${matched === 1 && !truncated ? 'is' : 'are'} recorded as already seen; ${later}`,
    }
  }
  const fresh = Math.max(0, Math.min(bt.newCases, matched))
  const one = matched === 1 && !truncated
  // Every case matching now is one it has not seen: nothing to tell apart.
  const allFresh = fresh === matched
  const freshWords = fresh.toLocaleString('en-US')
  if (bt.keepsCases) {
    const carry = 'Its query and key column stay the same, so its cases carry on'
    if (matched === 0) return { offer: null, text: `${carry}; none matches now. Each new case will fire as it appears.` }
    if (fresh === 0) return { offer: null, text: `${carry}: ${all} matching now ${one ? 'was' : 'were'} already seen and will not fire again. Each new case will fire as it appears.` }
    if (allFresh) return { offer: null, text: `${carry}: ${all} matching now ${one ? 'was' : 'were'} not seen yet and will fire on its next run.` }
    return { offer: null, text: `${carry}: of ${all} matching now, ${freshWords} not seen yet will fire on its next run; the others were already seen and will not fire again.` }
  }
  if (matched === 0) return { offer: null, text: 'Only cases that appear after you activate it will fire.' }
  if (fresh === 0) return { offer: null, text: `It has already seen ${all} matching now: ${one ? 'it' : 'they'} will not fire again, and ${later}` }
  const freshCases = theCases(fresh)
  if (allFresh) {
    return {
      offer: `Also alert on ${all} that match now`,
      text: notifyExisting
        ? `${upperFirst(all)} matching now will fire on its next run, then each new one as it appears.`
        : `${upperFirst(all)} matching now ${one ? 'is' : 'are'} recorded as already seen; ${later}`,
    }
  }
  return {
    offer: `Also alert on ${freshCases} matching now that it has not seen yet`,
    text: notifyExisting
      ? `Of ${all} matching now, ${freshWords} not seen yet will fire on its next run; the others were already seen and will not fire again. Then each new one fires as it appears.`
      : `Of ${all} matching now, ${freshWords} not seen yet ${fresh === 1 ? 'is' : 'are'} recorded as seen, like the others; ${later}`,
  }
}

/**
 * The conversation as cached, with a proposal's card as it stands now (after
 * Activate or Discard): every answer holding a card of that proposal gets the
 * new one; nothing else changes, and an untouched list is the same object.
 */
export function replaceAutomationPart(old: AiMessagesResponse | undefined, part: AiAutomationPart): AiMessagesResponse | undefined {
  if (!old) return old
  let changed = false
  const messages = old.messages.map((m) => {
    if (!m.parts.some((p) => p.type === 'automation' && p.proposalId === part.proposalId)) return m
    changed = true
    return { ...m, parts: m.parts.map((p) => (p.type === 'automation' && p.proposalId === part.proposalId ? part : p)) }
  })
  return changed ? { ...old, messages } : old
}

/**
 * The proposal a card is a newer version of (§22: its draft's
 * revisesProposalId), when the server accepted it — the server marks that
 * one replaced as it keeps the new one. Null for a first version, and for a
 * draft it refused (nothing was marked then).
 */
export function revisedProposalId(part: AiAutomationPart): string | null {
  const id = part.ok ? part.draft?.revisesProposalId : undefined
  return id && id !== part.proposalId ? id : null
}

/** A card of this proposal still to be decided: only those are marked replaced (one activated or discarded stays as it was). */
function isOpenCard(p: { type: string }, proposalId: string): p is AiAutomationPart {
  if (p.type !== 'automation') return false
  const card = p as AiAutomationPart
  return card.proposalId === proposalId && card.ok && card.state === 'proposed'
}

/** An answer's parts with the proposal's card marked replaced by a newer version; the same list when there is none to mark. */
export function supersedeParts<P extends { type: string }>(parts: P[], proposalId: string): P[] {
  if (!parts.some((p) => isOpenCard(p, proposalId))) return parts
  return parts.map((p) => (isOpenCard(p, proposalId) ? { ...p, state: 'superseded' as const } : p))
}

/**
 * The conversation as cached, with the card a newer version replaces marked
 * so at once, while the newer one is still being written (the server is
 * authoritative: the conversation fetched again says the same). Nothing else
 * changes, and an untouched list is the same object.
 */
export function supersedeAutomationPart(old: AiMessagesResponse | undefined, proposalId: string): AiMessagesResponse | undefined {
  if (!old) return old
  let changed = false
  const messages = old.messages.map((m) => {
    const parts = supersedeParts(m.parts, proposalId)
    if (parts === m.parts) return m
    changed = true
    return { ...m, parts }
  })
  return changed ? { ...old, messages } : old
}

/** What "Edit in chat" writes in the question box of a new conversation, so the assistant finds the automation (decision 13). */
export const editInChatText = (a: Pick<Automation, 'id' | 'name'>): string => `Change my automation "${a.name}" (id ${a.id}): `

// ---- State on the Automations page -----------------------------------------------------

/** Why an active automation does not run now; it resumes by itself once this is put right. */
export const BLOCKED_TEXT: Record<AutomationBlockedReason, string> = {
  'creator-inactive': "Its creator's account is deactivated or removed.",
  'no-access': 'Its creator no longer has the assistant, or no data to read.',
  'no-permission': 'Its creator may no longer create automations.',
  unavailable: 'The assistant is switched off or cannot read the data right now.',
}

export interface StatusView {
  key: 'active' | 'paused' | 'failed' | 'blocked'
  label: string
  tone: BadgeTone
  /** What it means, in full, for a tooltip or a notice. */
  tip: string
}

/** An automation's state as its chip shows it. */
export function automationStatus(a: Pick<Automation, 'status' | 'blockedReason' | 'statusNote'>): StatusView {
  if (a.status === 'failed') return { key: 'failed', label: 'Failed', tone: 'red', tip: a.statusNote ? stoppedText(a.statusNote) : 'Stopped after failing runs in a row. Resume it once the cause is put right.' }
  if (a.status === 'paused') return { key: 'paused', label: 'Paused', tone: 'neutral', tip: 'Paused by a person: it does not run until it is resumed.' }
  if (a.blockedReason) return { key: 'blocked', label: 'Blocked', tone: 'amber', tip: `${BLOCKED_TEXT[a.blockedReason] ?? 'It cannot run right now.'} It resumes by itself once this is put right.` }
  return { key: 'active', label: 'Active', tone: 'green', tip: 'On: it runs on its schedule.' }
}

/**
 * Why a failed automation stopped, from its status note: the server's note
 * says it whole ("Stopped after 5 failed runs in a row. The last one: …"); a
 * note that does not say it stopped is put after a word that does.
 */
export function stoppedText(statusNote: string): string {
  const note = statusNote.trim()
  return /^stopped\b/i.test(note) ? note : `Stopped after failing runs in a row: ${note}`
}

/** What the on/off switch of an automation in the list shows, and what pressing it does. */
export interface SwitchView {
  on: boolean
  action: 'pause' | 'resume'
  tip: string
}

/** On while it is set to run (a blocked one included: it waits, still on); pausing stops it, resuming starts it again. */
export function automationSwitch(a: Pick<Automation, 'status' | 'blockedReason'>): SwitchView {
  if (a.status === 'failed') return { on: false, action: 'resume', tip: 'Stopped after failing runs: switch it on to resume it, its failed runs forgotten' }
  if (a.status === 'paused') return { on: false, action: 'resume', tip: 'Paused: switch it on to resume it' }
  if (a.blockedReason) return { on: true, action: 'pause', tip: `On, but waiting: ${BLOCKED_TEXT[a.blockedReason] ?? 'it cannot run right now.'} Switch it off to pause it` }
  return { on: true, action: 'pause', tip: 'On: switch it off to pause it' }
}

/** The order of the states when the list is sorted by them: what needs attention first. */
export const STATUS_ORDER: Record<StatusView['key'], number> = { failed: 0, blocked: 1, active: 2, paused: 3 }

/** Why there is no next run, when there is none. */
export function noNextRunText(s: StatusView): string {
  return s.key === 'paused' ? 'Paused' : s.key === 'failed' ? 'Stopped' : s.key === 'blocked' ? 'Waiting' : '—'
}

// ---- Times, in the factory's clock ---------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * A moment in the factory's clock, short: "Today, 08:00", "Tomorrow, 07:30",
 * "Yesterday, 23:10", "Oct 12, 08:00", "Dec 30, 2025, 08:00" — whatever zone
 * the device is set to.
 */
export function factoryMoment(iso: string | null | undefined, timeZone: string, now: Date = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  const day = dayInTimeZone(d, timeZone)
  const today = dayInTimeZone(now, timeZone)
  if (day === today) return `Today, ${time}`
  if (day === dayInTimeZone(new Date(now.getTime() + DAY_MS), timeZone)) return `Tomorrow, ${time}`
  if (day === dayInTimeZone(new Date(now.getTime() - DAY_MS), timeZone)) return `Yesterday, ${time}`
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d)
  return `${date}, ${time}`
}

/** The whole moment in the factory's clock, for a tooltip: "Sat, Oct 10, 2026, 08:00:05 factory time". */
export function factoryTimestamp(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const text = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d)
  return `${text} factory time`
}

// ---- Runs and tests --------------------------------------------------------------------------

export interface RunOutcome {
  label: string
  tone: BadgeTone
}

/** How a run ended: still running, done, skipped (missed while the server was down), or failed. */
export function runOutcome(r: Pick<AutomationRun, 'finishedAt' | 'ok' | 'note' | 'ms'>): RunOutcome {
  if (r.finishedAt === null || r.ok === null) return { label: 'Running', tone: 'blue' }
  if (r.ok) return { label: 'Done', tone: 'green' }
  if (r.ms === 0 && r.note?.startsWith('Missed')) return { label: 'Skipped', tone: 'neutral' }
  return { label: 'Failed', tone: 'red' }
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * What a run found and did, in a line: "12 matched · 2 new · 5 alerts and
 * messages sent · 2 follow-ups". What was sent counts each bell alert and
 * each chat message (one person told on both is two), not people.
 */
export function runFigures(r: Pick<AutomationRun, 'matched' | 'fired' | 'notified' | 'followUps' | 'digest' | 'deliveryId'>, kind: AutomationKind): string {
  const parts: string[] = []
  if (kind === 'watch') {
    if (r.matched !== undefined) parts.push(`${r.matched.toLocaleString('en-US')} matched`)
    if (r.fired !== undefined) parts.push(`${r.fired.toLocaleString('en-US')} new`)
  } else if (r.deliveryId) parts.push('Delivered')
  if (r.notified !== undefined) parts.push(`${count(r.notified, 'alert or message', 'alerts and messages')} sent`)
  if (r.followUps) parts.push(count(r.followUps, 'follow-up'))
  if (r.digest) parts.push('as one digest')
  return parts.join(' · ')
}

/** What a toast says once "Run now" has run. */
export function runToast(r: AutomationRun, kind: AutomationKind): string {
  if (r.ok === false) return r.error ? `The run failed: ${r.error}` : 'The run failed.'
  const figures = runFigures(r, kind)
  return figures ? `Ran: ${figures}.` : 'Ran.'
}

/** A dry run in a sentence: what it would find and whom it would tell now. */
export function testSummary(t: AutomationTestResponse, kind: AutomationKind): string {
  if (!t.ok) return t.error ? `It failed: ${t.error}` : 'It failed.'
  if (kind === 'report') {
    const n = t.sections?.length ?? 0
    const failed = t.sections?.filter((s) => !s.ok).length ?? 0
    return failed > 0 ? `${failed} of ${count(n, 'section')} failed.` : `Its ${count(n, 'section')} ran.`
  }
  const matched = t.matched ?? 0
  const fresh = t.newCases ?? 0
  const people = t.recipients ?? 0
  const matchedWords = `${matched.toLocaleString('en-US')}${t.truncated ? '+' : ''} ${matched === 1 && !t.truncated ? 'case matches' : 'cases match'} now`
  const freshWords = fresh === 0 ? 'none of them is new' : fresh === matched && !t.truncated ? `${fresh === 1 ? 'it is' : 'all are'} new` : `${fresh.toLocaleString('en-US')} ${fresh === 1 ? 'is' : 'are'} new`
  const tell = fresh > 0 && people > 0 ? ` A run now would tell ${count(people, 'person', 'people')}.` : ''
  return matched === 0 ? 'No case matches now.' : `${matchedWords}; ${freshWords}.${tell}`
}

// ---- The edit form ------------------------------------------------------------------------------

/** A definition the form edits: a draft on a card, or an automation on its page. */
export type EditableDefinition = Pick<AutomationDraft, 'kind' | 'name' | 'description' | 'recipients' | 'channels' | 'actions' | 'watch' | 'schedule'>

export type PeriodKind = AiReportPeriod['kind']

/** The periods a report can take, in the order the form lists them. */
export const PERIOD_OPTIONS: { kind: PeriodKind; label: string }[] = [
  { kind: 'today', label: 'Today' },
  { kind: 'yesterday', label: 'Yesterday' },
  { kind: 'last_days', label: 'The last days…' },
  { kind: 'this_week', label: 'This week' },
  { kind: 'last_week', label: 'Last week' },
  { kind: 'this_month', label: 'This month' },
  { kind: 'last_month', label: 'Last month' },
  { kind: 'this_year', label: 'This year' },
  { kind: 'last_year', label: 'Last year' },
  { kind: 'fixed', label: 'Fixed days…' },
]

export const WEEK_START_OPTIONS: { value: AiWeekStart; label: string }[] = [
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
  { value: 'monday', label: 'Monday' },
]

/** The days of the week in the factory's order, Saturday first. */
export const FORM_WEEKDAYS: AutomationWeekday[] = [6, 0, 1, 2, 3, 4, 5]

/** A watch's intervals offered, in minutes; the one it has is always among them. */
export const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440]

export function intervalOptions(current: number): number[] {
  return [...new Set([...INTERVAL_PRESETS, current])].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
}

/** The edit form as typed. */
export interface AutomationForm {
  kind: AutomationKind
  name: string
  description: string
  recipients: AutomationRecipient[]
  channels: AutomationChannels
  notify: boolean
  followUp: boolean
  assignee: AutomationAssignee
  /** As typed. */
  dueHours: string
  everyMinutes: number
  /** A watch: whether it runs in some hours only, and which (as typed, HH:MM). */
  hoursOn: boolean
  hoursFrom: string
  hoursTo: string
  cadence: AutomationCadence
  time: string
  /** A watch, or a daily report: the days ticked (all seven: every day). */
  weekdays: AutomationWeekday[]
  weekday: AutomationWeekday
  monthDay: number
  /** Whether the report has a period at all: the form changes it, never adds or removes it (its queries depend on it). */
  hasPeriod: boolean
  periodKind: PeriodKind
  /** As typed. */
  periodDays: string
  periodWeekStart: AiWeekStart
  periodFrom: string
  periodTo: string
  summary: boolean
  /** A report sending a saved report: the values its inputs take, as typed, by name ('' takes its default on the day); null for one with sections of its own. */
  reportInputs: Record<string, string> | null
}

const ALL_DAYS: AutomationWeekday[] = [0, 1, 2, 3, 4, 5, 6]

/** A saved report's values as a form holds them: each as typed, a list joined with commas. */
const inputDraftsOf = (values: AiReportInputValues): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)]))

/** The form, filled from a definition. */
export function formFromDefinition(d: EditableDefinition): AutomationForm {
  const s = d.schedule
  const p = s?.period
  const w = d.watch
  const days = d.kind === 'watch' ? w?.weekdays : s?.cadence === 'daily' ? s.weekdays : undefined
  return {
    kind: d.kind,
    name: d.name,
    description: d.description,
    // A view carries a label; the form keeps what a definition holds.
    recipients: d.recipients.map(bareRecipient),
    channels: { bell: d.channels.bell, chat: d.channels.chat },
    notify: d.actions.notify,
    followUp: d.actions.followUp !== null,
    assignee: d.actions.followUp ? bareAssignee(d.actions.followUp.assignee) : { kind: 'creator' },
    dueHours: String(d.actions.followUp?.dueHours ?? 24),
    everyMinutes: w?.everyMinutes ?? AUTOMATION_MIN_EVERY_MINUTES,
    hoursOn: !!w?.hours,
    hoursFrom: w?.hours?.from ?? '07:00',
    hoursTo: w?.hours?.to ?? '16:00',
    cadence: s?.cadence ?? 'daily',
    time: s?.time ?? '08:00',
    weekdays: days?.length ? [...new Set(days)] : [...ALL_DAYS],
    weekday: s?.weekday ?? 6,
    monthDay: s?.monthDay ?? 1,
    hasPeriod: !!p,
    periodKind: p?.kind ?? 'yesterday',
    periodDays: p?.kind === 'last_days' ? String(p.days) : '7',
    periodWeekStart: p && (p.kind === 'this_week' || p.kind === 'last_week') ? p.weekStart : 'saturday',
    periodFrom: p?.kind === 'fixed' ? p.from : '',
    periodTo: p?.kind === 'fixed' ? p.to : '',
    summary: s?.summary ?? false,
    reportInputs: s?.report ? inputDraftsOf(s.report.inputs ?? {}) : null,
  }
}

export function bareRecipient(r: AutomationRecipient): AutomationRecipient {
  return r.kind === 'user' ? { kind: 'user', userId: r.userId } : r.kind === 'role' ? { kind: 'role', role: r.role } : { kind: 'column', column: r.column }
}

export function bareAssignee(a: AutomationAssignee): AutomationAssignee {
  return a.kind === 'user' ? { kind: 'user', userId: a.userId } : a.kind === 'column' ? { kind: 'column', column: a.column } : { kind: 'creator' }
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const chars = (s: string) => Array.from(s).length
/** A whole number as typed, or null. */
const wholeNumber = (raw: string): number | null => (/^\s*\d+\s*$/.test(raw) ? Number(raw.trim()) : null)

/** The report's period as the form holds it; null when it has none or what is typed is not one. */
export function formPeriod(f: AutomationForm): AiReportPeriod | null {
  if (!f.hasPeriod) return null
  switch (f.periodKind) {
    case 'last_days': {
      const days = wholeNumber(f.periodDays)
      return days !== null && days >= 1 && days <= AI_REPORT_MAX_DAYS ? { kind: 'last_days', days } : null
    }
    case 'this_week':
    case 'last_week':
      return { kind: f.periodKind, weekStart: f.periodWeekStart }
    case 'fixed':
      return checkAiDayRange(f.periodFrom, f.periodTo) === null ? { kind: 'fixed', from: f.periodFrom, to: f.periodTo } : null
    default:
      return { kind: f.periodKind }
  }
}

/** Why the form cannot be saved, or null when it can. The server checks it all again, with the queries' results. */
export function checkAutomationForm(f: AutomationForm): string | null {
  const name = oneLine(f.name)
  if (!name) return 'Give it a name.'
  if (chars(name) > AUTOMATION_NAME_MAX) return `The name takes at most ${AUTOMATION_NAME_MAX} characters.`
  const description = f.description.trim()
  if (!description) return 'Say in a few words what it does.'
  if (chars(description) > AUTOMATION_DESCRIPTION_MAX) return `The description takes at most ${AUTOMATION_DESCRIPTION_MAX.toLocaleString('en-US')} characters.`
  if (f.kind === 'watch') {
    if (!Number.isInteger(f.everyMinutes) || f.everyMinutes < AUTOMATION_MIN_EVERY_MINUTES || f.everyMinutes > AUTOMATION_MAX_EVERY_MINUTES) {
      return `A watch runs every ${AUTOMATION_MIN_EVERY_MINUTES} to ${AUTOMATION_MAX_EVERY_MINUTES.toLocaleString('en-US')} minutes.`
    }
    if (f.hoursOn) {
      if (!isAutomationTime(f.hoursFrom) || !isAutomationTime(f.hoursTo)) return 'Choose the hours it runs in, on the 24-hour clock (HH:MM).'
      if (f.hoursFrom === f.hoursTo) return 'Its hours start and end at the same time: choose a later end, or let it run around the clock.'
    }
    if (f.weekdays.length === 0) return 'Tick at least one day it runs.'
    if (!f.notify && !f.followUp) return 'A watch must tell people, open a follow-up for each case, or both.'
    if (f.followUp) {
      const due = wholeNumber(f.dueHours)
      if (due === null || due < FOLLOW_UP_MIN_DUE_HOURS || due > FOLLOW_UP_MAX_DUE_HOURS) {
        return `The follow-up's deadline is ${FOLLOW_UP_MIN_DUE_HOURS} to ${FOLLOW_UP_MAX_DUE_HOURS} hours after the case.`
      }
      if (f.assignee.kind === 'user' && !f.assignee.userId) return 'Choose who the follow-ups go to.'
      if (f.assignee.kind === 'column' && !f.assignee.column.trim()) return 'Choose the column that names who each follow-up goes to.'
    }
  } else {
    if (!isAutomationTime(f.time)) return 'Choose the time it runs, on the 24-hour clock (HH:MM).'
    if (f.cadence === 'daily' && f.weekdays.length === 0) return 'Tick at least one day it runs.'
    if (f.cadence === 'weekly' && !isAutomationWeekday(f.weekday)) return 'Choose the day of the week it runs.'
    if (f.cadence === 'monthly' && (!Number.isInteger(f.monthDay) || f.monthDay < 1 || f.monthDay > 28)) return 'Choose a day of the month from 1 to 28.'
    if (f.hasPeriod && !formPeriod(f)) {
      if (f.periodKind === 'last_days') return `The number of days is a whole number from 1 to ${AI_REPORT_MAX_DAYS.toLocaleString('en-US')}.`
      if (f.periodKind === 'fixed') return checkAiDayRange(f.periodFrom, f.periodTo) ?? 'Choose the first and the last day.'
      return 'Choose the days it covers.'
    }
  }
  const told = f.kind === 'report' || f.notify
  if (told && f.recipients.length === 0) return 'Choose at least one person, role or column of people to tell.'
  if (f.recipients.length > AUTOMATION_MAX_RECIPIENTS) return `At most ${AUTOMATION_MAX_RECIPIENTS} recipients.`
  if (!f.channels.bell && !f.channels.chat) return 'Choose the bell, the chat, or both.'
  return null
}

/** The actions the form holds. Call checkAutomationForm first: an unreadable deadline goes as the minimum. */
export function formActions(f: AutomationForm): AutomationActions {
  if (f.kind === 'report') return { notify: true, followUp: null }
  return {
    notify: f.notify,
    followUp: f.followUp ? { assignee: bareAssignee(f.assignee), dueHours: wholeNumber(f.dueHours) ?? FOLLOW_UP_MIN_DUE_HOURS } : null,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sortedDays = (days: readonly number[]) => [...new Set(days)].sort((a, b) => a - b) as AutomationWeekday[]

/** The days ticked as the server takes them: null for all seven (every day); undefined when they are the days it already has. */
function weekdaysEdit(ticked: readonly AutomationWeekday[], before: readonly AutomationWeekday[] | undefined): AutomationWeekday[] | null | undefined {
  const days = sortedDays(ticked)
  const next = days.length === 7 ? null : days
  const was = before?.length && sortedDays(before).length < 7 ? sortedDays(before) : null
  return same(next, was) ? undefined : next
}

/**
 * The changes the form makes to a definition, as the server takes them: only
 * the fields that differ. A watch or a daily report ticked for all seven days
 * runs every day (weekdays: null); a watch running around the clock has no
 * hours (hours: null). Call checkAutomationForm first.
 */
export function editsFromForm(d: EditableDefinition, f: AutomationForm): AutomationEdits {
  const edits: AutomationEdits = {}
  const name = oneLine(f.name)
  if (name !== d.name) edits.name = name
  const description = f.description.trim()
  if (description !== d.description) edits.description = description
  const recipients = f.recipients.map(bareRecipient)
  if (!same(recipients, d.recipients.map(bareRecipient))) edits.recipients = recipients
  if (f.channels.bell !== d.channels.bell || f.channels.chat !== d.channels.chat) edits.channels = { bell: f.channels.bell, chat: f.channels.chat }
  if (d.kind === 'watch') {
    const actions = formActions(f)
    const before: AutomationActions = d.actions.followUp ? { notify: d.actions.notify, followUp: { assignee: bareAssignee(d.actions.followUp.assignee), dueHours: d.actions.followUp.dueHours } } : { notify: d.actions.notify, followUp: null }
    if (!same(actions, before)) edits.actions = actions
    if (d.watch) {
      if (f.everyMinutes !== d.watch.everyMinutes) edits.everyMinutes = f.everyMinutes
      const hours: AutomationHours | null = f.hoursOn ? { from: f.hoursFrom, to: f.hoursTo } : null
      if (!same(hours, d.watch.hours ?? null)) edits.hours = hours
      const days = weekdaysEdit(f.weekdays, d.watch.weekdays)
      if (days !== undefined) edits.weekdays = days
    }
    return edits
  }
  const s = d.schedule
  if (!s) return edits
  const cadenceChanged = f.cadence !== s.cadence
  if (cadenceChanged) edits.cadence = f.cadence
  if (f.time !== s.time) edits.time = f.time
  if (f.cadence === 'daily') {
    const days = weekdaysEdit(f.weekdays, s.cadence === 'daily' ? s.weekdays : undefined)
    if (days !== undefined) edits.weekdays = days
  }
  if (f.cadence === 'weekly' && (cadenceChanged || f.weekday !== s.weekday)) edits.weekday = f.weekday
  if (f.cadence === 'monthly' && (cadenceChanged || f.monthDay !== s.monthDay)) edits.monthDay = f.monthDay
  const period = formPeriod(f)
  if (s.period && period && !same(period, s.period)) edits.period = period
  if (f.summary !== s.summary) edits.summary = f.summary
  // A saved report's values: those typed (the server reads each as its input takes it); an empty field takes its default on the day.
  if (s.report && f.reportInputs) {
    const typed = Object.fromEntries(Object.entries(f.reportInputs).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''))
    const before = Object.fromEntries(Object.entries(inputDraftsOf(s.report.inputs ?? {})).filter(([, v]) => v !== ''))
    if (!same(sortedEntries(typed), sortedEntries(before))) edits.reportInputs = typed
  }
  return edits
}

const sortedEntries = (o: Record<string, string>) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

export const hasEdits = (e: AutomationEdits | null | undefined): boolean => !!e && Object.keys(e).length > 0

/**
 * A definition with changes on top, as the server applies them (a change of
 * cadence takes the fields the old one used away with it, unless given
 * anew; hours or days set to null are taken away): what the card shows of a
 * proposal edited before it is activated.
 */
export function applyEdits<T extends EditableDefinition>(d: T, e: AutomationEdits): T {
  const next: T = structuredClone(d)
  if (e.name !== undefined) next.name = e.name
  if (e.description !== undefined) next.description = e.description
  if (e.recipients !== undefined) next.recipients = e.recipients.map(bareRecipient)
  if (e.channels !== undefined) next.channels = { ...e.channels }
  if (next.kind === 'watch') {
    if (e.actions !== undefined) next.actions = structuredClone(e.actions)
    if (next.watch) {
      const w: AutomationWatchSpec = { ...next.watch }
      if (e.everyMinutes !== undefined) w.everyMinutes = e.everyMinutes
      if (e.hours !== undefined) {
        if (e.hours === null) delete w.hours
        else w.hours = { ...e.hours }
      }
      if (e.weekdays !== undefined) {
        if (e.weekdays === null) delete w.weekdays
        else w.weekdays = [...e.weekdays]
      }
      next.watch = w
    }
    return next
  }
  if (!next.schedule) return next
  const s: AutomationScheduleSpec = { ...next.schedule }
  if (e.cadence !== undefined) s.cadence = e.cadence
  if (e.time !== undefined) s.time = e.time
  if (e.weekdays !== undefined) setOrDrop(s, 'weekdays', e.weekdays)
  if (e.weekday !== undefined) setOrDrop(s, 'weekday', e.weekday)
  if (e.monthDay !== undefined) setOrDrop(s, 'monthDay', e.monthDay)
  if (e.period !== undefined) setOrDrop(s, 'period', e.period)
  if (e.summary !== undefined) s.summary = e.summary
  if (e.reportInputs !== undefined && s.report) s.report = { ...s.report, inputs: { ...e.reportInputs } }
  if (e.cadence !== undefined) {
    if (s.cadence !== 'daily' && e.weekdays === undefined) delete s.weekdays
    if (s.cadence !== 'weekly' && e.weekday === undefined) delete s.weekday
    if (s.cadence !== 'monthly' && e.monthDay === undefined) delete s.monthDay
  }
  next.schedule = s
  return next
}

function setOrDrop<K extends 'weekdays' | 'weekday' | 'monthDay' | 'period'>(s: AutomationScheduleSpec, key: K, value: AutomationScheduleSpec[K] | null): void {
  if (value === null || value === undefined) delete s[key]
  else s[key] = value
}

/**
 * The result columns a watch is known to have, for choosing a column of
 * people: those its definition names (the key, the links, the templates'
 * placeholders, its column recipients and assignee) and any a run showed.
 */
export function knownWatchColumns(d: Pick<EditableDefinition, 'watch' | 'recipients' | 'actions'>, seen: readonly string[] | null | undefined = null): string[] {
  const w = d.watch
  const named = [
    ...(seen ?? []),
    ...(w ? [w.keyColumn, w.sessionColumn, w.sampleColumn, w.orderColumn] : []),
    ...(w ? templatePlaceholders(w.titleTemplate) : []),
    ...(w?.bodyTemplate ? templatePlaceholders(w.bodyTemplate) : []),
    ...d.recipients.flatMap((r) => (r.kind === 'column' ? [r.column] : [])),
    ...(d.actions.followUp?.assignee.kind === 'column' ? [d.actions.followUp.assignee.column] : []),
  ]
  return [...new Set(named.filter((c): c is string => typeof c === 'string' && c.trim() !== ''))]
}

/** A weekday's short name, for a toggle: "Sat". */
export const weekdayShort = (d: AutomationWeekday): string => weekdayName(d).slice(0, 3)

const DEFAULT_WORDS: Record<NonNullable<AiReportInput['dynamicDefault']>, string> = {
  this_week: "this week's, on the day it runs",
  this_year: 'this year, on the day it runs',
  today: 'the day it runs',
}

/**
 * The values a schedule sends a saved report with, a line each in the report's order: the value given, or what an
 * input left empty takes on the day ("Planning week: this week's, on the day it runs"; "Leave out these orders: none").
 */
export function linkedValuesLines(inputs: readonly AiReportInput[], values: AiReportInputValues): string[] {
  return inputs.map((i) => {
    const v = values[i.name]
    const given = v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
    if (given) return `${i.label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`
    if (i.dynamicDefault) return `${i.label}: ${DEFAULT_WORDS[i.dynamicDefault]}`
    if (i.default !== undefined && i.default !== null) return `${i.label}: ${Array.isArray(i.default) ? i.default.join(', ') : String(i.default)} (its default)`
    return `${i.label}: ${i.kind === 'list' ? 'none' : 'any'}`
  })
}
