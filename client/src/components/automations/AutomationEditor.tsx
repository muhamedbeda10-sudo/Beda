// ============================================================================
// §21 — changing an automation outside the chat: its name and words, whom it
// tells and where, what a watch does with each case (tell, open a follow-up
// for someone with a deadline) and when it looks (how often, in which hours
// of the factory day, on which days), when a report runs and over which
// days, and whether it has a summary. The queries are not here:
// they change only through the assistant ("Edit in chat"). The same form
// edits a proposal on its card before it is activated and an automation on
// its page; it is checked here as the server checks it, and the server
// checks it again (with the queries' results) when it is saved.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, Pencil, Save, X } from 'lucide-react'
import {
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_MAX_RECIPIENTS,
  AUTOMATION_NAME_MAX,
  FOLLOW_UP_MAX_DUE_HOURS,
  FOLLOW_UP_MIN_DUE_HOURS,
  describeWatchInterval,
  isAutomationTime,
  weekdayName,
  type AutomationAssignee,
  type AutomationAssigneeView,
  type AutomationCadence,
  type AutomationEdits,
  type AutomationPeopleResponse,
  type AutomationRecipient,
  type AutomationRecipientView,
  type AutomationWeekday,
} from '@qc/shared/automation'
import type { Role } from '@qc/shared/types'
import { Button, Drawer, Field, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import { groupByRole } from '@/components/ai/access'
import { useAutomationPeople } from '@/services/automations'
import { ErrorList, errorLines } from './parts'
import { ReportInputFields } from '@/components/ai/AiReportLayouts'
import type { AiReportInput } from '@qc/shared/aiReportInputs'
import {
  FORM_WEEKDAYS,
  PERIOD_OPTIONS,
  WEEK_START_OPTIONS,
  ROLE_RECIPIENT_LABEL,
  applyEdits,
  checkAutomationForm,
  describeDueHours,
  editsFromForm,
  formFromDefinition,
  intervalOptions,
  recipientViews,
  roleName,
  weekdayShort,
  type AutomationForm,
  type AutomationPerson,
  type EditableDefinition,
  type PeriodKind,
} from './wording'

const CADENCES: { value: AutomationCadence; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

const HOURS_CHOICES: { value: 'all' | 'some'; label: string }[] = [
  { value: 'all', label: 'Around the clock' },
  { value: 'some', label: 'Some hours only' },
]

/** The days with one of them ticked or unticked. */
const toggledDays = (days: readonly AutomationWeekday[], d: AutomationWeekday): AutomationWeekday[] => (days.includes(d) ? days.filter((x) => x !== d) : [...days, d])

/** What a watch's hours mean as typed: the night when the end comes first; what is wrong with them otherwise. */
function hoursHint(f: AutomationForm): string {
  if (!f.hoursOn) return 'It looks all day and all night.'
  if (!isAutomationTime(f.hoursFrom) || !isAutomationTime(f.hoursTo)) return 'Both times on the 24-hour clock, HH:MM.'
  if (f.hoursFrom === f.hoursTo) return 'The same time twice: choose a later end, or let it run around the clock.'
  if (f.hoursTo < f.hoursFrom) return `From ${f.hoursFrom} to ${f.hoursTo} the next morning: the night counts as the day it starts on.`
  return `From ${f.hoursFrom} to ${f.hoursTo}, ${describeWatchInterval(f.everyMinutes).toLowerCase()}; its last look is before ${f.hoursTo}.`
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`

const CHECK = 'mt-0.5 h-4 w-4 shrink-0 accent-brand-600'
const OPTION = 'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-[:disabled]:cursor-default'
const optionTone = (on: boolean) =>
  on ? 'border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50'

/** An assignee as a select's value: "creator", "user:<id>", "column:<name>". */
const assigneeValue = (a: AutomationAssignee): string => (a.kind === 'creator' ? 'creator' : a.kind === 'user' ? `user:${a.userId}` : `column:${a.column}`)

function parseAssignee(value: string): AutomationAssignee {
  if (value.startsWith('user:')) return { kind: 'user', userId: value.slice(5) }
  if (value.startsWith('column:')) return { kind: 'column', column: value.slice(7) }
  return { kind: 'creator' }
}

export function AutomationEditor({
  base,
  initialEdits = null,
  knownRecipients,
  knownAssignee,
  creatorName,
  columns,
  title,
  subtitle,
  saveLabel,
  footnote,
  reportInputs,
  onSave,
  onClose,
}: {
  /** The definition as saved (or as proposed): the edits are worked out against it. */
  base: EditableDefinition
  /** Changes already made (on a card, before activation): the form starts from them. */
  initialEdits?: AutomationEdits | null
  /** The names the server gave its recipients and assignee, for anyone the people list no longer has. */
  knownRecipients: readonly AutomationRecipientView[]
  knownAssignee?: AutomationAssigneeView
  /** Whose automation it is: "the creator" as an assignee. */
  creatorName: string
  /** A watch's result columns as far as they are known: a column of people to tell, or to assign. */
  columns: readonly string[]
  title: string
  subtitle?: ReactNode
  saveLabel: string
  /** A word under the form (where the queries are changed). */
  footnote?: ReactNode
  /** A report sending a saved report: what the report asks for, so its values can be changed here. */
  reportInputs?: readonly AiReportInput[]
  /** Keep the changes; a refusal thrown here is shown in the form. An empty change is passed on too (all undone). */
  onSave: (edits: AutomationEdits) => Promise<void> | void
  onClose: () => void
}) {
  const people = useAutomationPeople(true)
  const start = useMemo(() => formFromDefinition(initialEdits ? applyEdits(base, initialEdits) : base), [base, initialEdits])
  const [form, setForm] = useState<AutomationForm>(start)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<string[] | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (problems) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [problems])

  const patch = (p: Partial<AutomationForm>) => {
    setForm((f) => ({ ...f, ...p }))
    setProblems(null)
  }

  const peopleMap = useMemo(() => (people.data ? new Map<string, AutomationPerson>(people.data.people.map((p) => [p.id, p])) : null), [people.data])
  const changed = JSON.stringify(editsFromForm(base, form)) !== JSON.stringify(editsFromForm(base, start))
  const watch = form.kind === 'watch'

  const save = async () => {
    const why = checkAutomationForm(form)
    if (why) {
      setProblems([why])
      return
    }
    setSaving(true)
    try {
      await onSave(editsFromForm(base, form))
    } catch (e) {
      setProblems(errorLines(e, 'Could not save the changes.'))
      setSaving(false)
    }
  }

  return (
    <Drawer
      open
      onClose={() => !saving && onClose()}
      icon={<Pencil className="h-5 w-5" />}
      title={<span dir="auto">{title}</span>}
      subtitle={subtitle}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            <X className="h-4 w-4" /> Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !changed}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {saving ? 'Saving…' : saveLabel}
          </Button>
        </>
      }
    >
      <form
        className="ai-type space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <fieldset className="space-y-3" disabled={saving}>
          <Field label="Name">
            <Input dir="auto" value={form.name} maxLength={AUTOMATION_NAME_MAX} onChange={(e) => patch({ name: e.target.value })} className="min-h-[44px]" />
          </Field>
          <Field label="What it does, in plain words">
            <textarea
              dir="auto"
              value={form.description}
              maxLength={AUTOMATION_DESCRIPTION_MAX}
              rows={3}
              onChange={(e) => patch({ description: e.target.value })}
              className="input min-h-[88px] resize-y py-2 leading-snug"
            />
          </Field>
        </fieldset>

        {watch ? <WatchFields form={form} patch={patch} disabled={saving} people={people.data?.people ?? null} columns={columns} creatorName={creatorName} known={knownAssignee} hasSession={!!base.watch?.sessionColumn} /> : <ScheduleFields form={form} patch={patch} disabled={saving} reportInputs={reportInputs} />}

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="label">Who is told</legend>
          <p className="text-xs text-muted">
            {watch
              ? `People, everyone with a role when it runs, or the people a column of each case names (a column of user ids). At most ${AUTOMATION_MAX_RECIPIENTS}. ${form.notify ? '' : 'Not needed while it only opens follow-ups.'}`
              : `People, or everyone with a role when it runs. At most ${AUTOMATION_MAX_RECIPIENTS}.`}
          </p>
          <RecipientsField
            value={form.recipients}
            onChange={(recipients) => patch({ recipients })}
            people={people.data?.people ?? null}
            peopleMap={peopleMap}
            roles={people.data?.roles ?? []}
            columns={watch ? columns : null}
            known={knownRecipients}
            loading={people.isLoading}
          />
        </fieldset>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="label">Where they are told</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={cn(OPTION, optionTone(form.channels.bell))}>
              <input type="checkbox" checked={form.channels.bell} onChange={(e) => patch({ channels: { ...form.channels, bell: e.target.checked } })} className={CHECK} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">The bell</span>
                <span className="block text-xs text-muted">An alert in the app's bell, that opens what it is about.</span>
              </span>
            </label>
            <label className={cn(OPTION, optionTone(form.channels.chat))}>
              <input type="checkbox" checked={form.channels.chat} onChange={(e) => patch({ channels: { ...form.channels, chat: e.target.checked } })} className={CHECK} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">The chat</span>
                <span className="block text-xs text-muted">A message from “QC Automations”, one per run.</span>
              </span>
            </label>
          </div>
        </fieldset>

        {footnote && <div className="text-xs text-muted">{footnote}</div>}
        <div ref={errorRef}>
          <ErrorList lines={problems} />
        </div>
      </form>
    </Drawer>
  )
}

// ---- A watch -------------------------------------------------------------------------------------

function WatchFields({
  form,
  patch,
  disabled,
  people,
  columns,
  creatorName,
  known,
  hasSession,
}: {
  form: AutomationForm
  patch: (p: Partial<AutomationForm>) => void
  disabled: boolean
  people: AutomationPeopleResponse['people'] | null
  columns: readonly string[]
  creatorName: string
  known?: AutomationAssigneeView
  hasSession: boolean
}) {
  const due = Number(form.dueHours)
  const groups = useMemo(() => groupByRole(people ?? []), [people])
  // The assignee as saved stays offered even when the lists no longer have it (an account switched off, a column not seen).
  const current = form.assignee
  const currentMissing =
    (current.kind === 'user' && !!people && !people.some((p) => p.id === current.userId)) || (current.kind === 'column' && !columns.includes(current.column))
  const missingLabel = current.kind === 'user' ? `${known?.kind === 'user' && known.userId === current.userId ? known.label : 'Unknown account'} (no longer active)` : current.kind === 'column' ? `The person in "${current.column}"` : ''
  return (
    <>
      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="label">When it looks (factory time)</legend>
        <Field label="How often">
          <Select value={String(form.everyMinutes)} onChange={(e) => patch({ everyMinutes: Number(e.target.value) })} className="min-h-[44px] sm:max-w-xs">
            {intervalOptions(form.everyMinutes).map((n) => (
              <option key={n} value={n}>
                {describeWatchInterval(n)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-1.5">
          <span className="label">In which hours</span>
          <Segmented label="In which hours" value={form.hoursOn ? 'some' : 'all'} options={HOURS_CHOICES} onChange={(v) => patch({ hoursOn: v === 'some' })} />
          {form.hoursOn && (
            <div className="flex flex-wrap items-center gap-2">
              <Input type="time" aria-label="From" value={form.hoursFrom} onChange={(e) => patch({ hoursFrom: e.target.value })} className="min-h-[44px] w-[8.5rem] tabular-nums" step={60} />
              <span aria-hidden className="text-sm text-muted">
                to
              </span>
              <Input type="time" aria-label="To" value={form.hoursTo} onChange={(e) => patch({ hoursTo: e.target.value })} className="min-h-[44px] w-[8.5rem] tabular-nums" step={60} />
            </div>
          )}
          <p className="text-xs text-muted">{hoursHint(form)}</p>
        </div>
        <div className="space-y-1.5">
          <span className="label">On which days</span>
          <WeekdayPicker weekdays={form.weekdays} onToggle={(d) => patch({ weekdays: toggledDays(form.weekdays, d) })} />
          <p className="text-xs text-muted">All seven ticked: every day.</p>
        </div>
        <p className="text-xs text-muted">Each run looks at what its query returns now; a case fires once, the first time it is seen. Outside its hours it waits: a case appearing then is found at its next look.</p>
      </fieldset>

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="label">What it does with each new case</legend>
        <label className={cn(OPTION, optionTone(form.notify))}>
          <input type="checkbox" checked={form.notify} onChange={(e) => patch({ notify: e.target.checked })} className={CHECK} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Tell the people below</span>
            <span className="block text-xs text-muted">One alert per case — or one digest when a run finds many.</span>
          </span>
        </label>
        <div className={cn('rounded-xl border transition-colors', optionTone(form.followUp))}>
          <label className="flex cursor-pointer items-start gap-3 p-3">
            <input type="checkbox" checked={form.followUp} onChange={(e) => patch({ followUp: e.target.checked })} className={CHECK} />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Open a follow-up</span>
              <span className="block text-xs text-muted">
                Someone to look into it by a deadline; the automation's creator is told when it is overdue.
                {hasSession && ' Its session reads “Needs review” in History until the follow-up is closed.'}
              </span>
            </span>
          </label>
          {form.followUp && (
            <div className="grid gap-3 border-t border-slate-200/70 p-3 dark:border-slate-700/60 sm:grid-cols-2">
              <Field label="Assigned to">
                <Select value={assigneeValue(form.assignee)} onChange={(e) => patch({ assignee: parseAssignee(e.target.value) })} className="min-h-[44px]">
                  <option value="creator">{creatorName} (creator)</option>
                  {currentMissing && <option value={assigneeValue(current)}>{missingLabel}</option>}
                  {columns.length > 0 && (
                    <optgroup label="The person a column names">
                      {columns.map((c) => (
                        <option key={c} value={`column:${c}`}>
                          The person in "{c}"
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {groups.map(([role, list]) => (
                    <optgroup key={role} label={roleName(role)}>
                      {list.map((p) => (
                        <option key={p.id} value={`user:${p.id}`}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>
              <Field label="Deadline (hours after the case)" hint={Number.isInteger(due) && due > 0 ? describeDueHours(due) : `${FOLLOW_UP_MIN_DUE_HOURS} to ${FOLLOW_UP_MAX_DUE_HOURS}`}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={FOLLOW_UP_MIN_DUE_HOURS}
                  max={FOLLOW_UP_MAX_DUE_HOURS}
                  step={1}
                  value={form.dueHours}
                  onChange={(e) => patch({ dueHours: e.target.value })}
                  className="min-h-[44px] tabular-nums"
                />
              </Field>
            </div>
          )}
        </div>
      </fieldset>
    </>
  )
}

// ---- A report --------------------------------------------------------------------------------------

/** A row of choices, one pressed: the cadence of a report, the hours of a watch. */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-800">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-9 items-center rounded-md px-3 text-13 font-semibold transition-colors touch:h-11',
            value === o.value ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-muted hover:text-slate-700 dark:hover:text-slate-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** The days of the week, Saturday first, each ticked or not. */
function WeekdayPicker({ weekdays, onToggle }: { weekdays: readonly AutomationWeekday[]; onToggle: (d: AutomationWeekday) => void }) {
  return (
    <div role="group" aria-label="The days it runs" className="flex flex-wrap gap-1.5">
      {FORM_WEEKDAYS.map((d) => {
        const on = weekdays.includes(d)
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            aria-label={weekdayName(d)}
            onClick={() => onToggle(d)}
            className={cn(
              'h-10 min-w-[3.25rem] rounded-lg px-2 text-13 font-semibold ring-1 ring-inset transition-colors touch:h-11',
              on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
            )}
          >
            {weekdayShort(d)}
          </button>
        )
      })}
    </div>
  )
}

function ScheduleFields({
  form,
  patch,
  disabled,
  reportInputs,
}: {
  form: AutomationForm
  patch: (p: Partial<AutomationForm>) => void
  disabled: boolean
  reportInputs?: readonly AiReportInput[]
}) {
  return (
    <>
      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="label">When it runs (factory time)</legend>
        <Segmented label="How often" value={form.cadence} options={CADENCES} onChange={(cadence) => patch({ cadence })} />

        {form.cadence === 'daily' && (
          <div className="space-y-1.5">
            <WeekdayPicker weekdays={form.weekdays} onToggle={(d) => patch({ weekdays: toggledDays(form.weekdays, d) })} />
            <p className="text-xs text-muted">All seven ticked: every day.</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {form.cadence === 'weekly' && (
            <Field label="Day">
              <Select value={String(form.weekday)} onChange={(e) => patch({ weekday: Number(e.target.value) as AutomationWeekday })} className="min-h-[44px]">
                {FORM_WEEKDAYS.map((d) => (
                  <option key={d} value={d}>
                    {weekdayName(d)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {form.cadence === 'monthly' && (
            <Field label="Day of the month" hint="1 to 28: every month has it.">
              <Select value={String(form.monthDay)} onChange={(e) => patch({ monthDay: Number(e.target.value) })} className="min-h-[44px]">
                {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    The {ordinal(n)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Time">
            <Input type="time" value={form.time} onChange={(e) => patch({ time: e.target.value })} className="min-h-[44px] tabular-nums" step={60} />
          </Field>
        </div>
      </fieldset>

      {form.reportInputs && reportInputs && reportInputs.length > 0 && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="label">The values it sends the report with</legend>
          <p className="text-xs text-muted">The same on every run. Leave one empty to take its default on the day it runs (this week, this year, today).</p>
          <ReportInputFields
            inputs={reportInputs}
            drafts={form.reportInputs}
            onChange={(name, value) => patch({ reportInputs: { ...(form.reportInputs ?? {}), [name]: value } })}
            optional
            idPrefix="automation-report-input"
            className="grid gap-3 sm:grid-cols-2"
          />
        </fieldset>
      )}

      {form.hasPeriod && (
        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="label">The days it covers</legend>
          <p className="text-xs text-muted">Counted from the day it runs; its queries take them as their first and last day.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select aria-label="Period" value={form.periodKind} onChange={(e) => patch({ periodKind: e.target.value as PeriodKind })} className="min-h-[44px]">
              {PERIOD_OPTIONS.map((o) => (
                <option key={o.kind} value={o.kind}>
                  {o.label}
                </option>
              ))}
            </Select>
            {form.periodKind === 'last_days' && (
              <label className="flex items-center gap-2 text-sm">
                <Input type="number" inputMode="numeric" min={1} step={1} aria-label="How many days, today included" value={form.periodDays} onChange={(e) => patch({ periodDays: e.target.value })} className="min-h-[44px] w-28 tabular-nums" />
                <span className="text-muted">days, today included</span>
              </label>
            )}
            {(form.periodKind === 'this_week' || form.periodKind === 'last_week') && (
              <Select aria-label="The week starts on" value={form.periodWeekStart} onChange={(e) => patch({ periodWeekStart: e.target.value as AutomationForm['periodWeekStart'] })} className="min-h-[44px]">
                {WEEK_START_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    Weeks start on {o.label}
                  </option>
                ))}
              </Select>
            )}
          </div>
          {form.periodKind === 'fixed' && (
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" aria-label="First day" value={form.periodFrom} max={form.periodTo || undefined} onChange={(e) => patch({ periodFrom: e.target.value })} className="min-h-[44px] w-[10rem] tabular-nums" />
              <span aria-hidden className="text-muted">
                –
              </span>
              <Input type="date" aria-label="Last day" value={form.periodTo} min={form.periodFrom || undefined} onChange={(e) => patch({ periodTo: e.target.value })} className="min-h-[44px] w-[10rem] tabular-nums" />
            </div>
          )}
        </fieldset>
      )}

      <fieldset disabled={disabled}>
        <label className={cn(OPTION, optionTone(form.summary))}>
          <input type="checkbox" checked={form.summary} onChange={(e) => patch({ summary: e.target.checked })} className={CHECK} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">A short summary on top</span>
            <span className="block text-xs text-muted">Written by the assistant from the sections each time it runs, in the language the report was asked in.</span>
          </span>
        </label>
      </fieldset>
    </>
  )
}

// ---- Recipients ---------------------------------------------------------------------------------------

const recipientKey = (r: AutomationRecipient) => (r.kind === 'user' ? `user:${r.userId}` : r.kind === 'role' ? `role:${r.role}` : `column:${r.column}`)

function RecipientsField({
  value,
  onChange,
  people,
  peopleMap,
  roles,
  columns,
  known,
  loading,
}: {
  value: AutomationRecipient[]
  onChange: (next: AutomationRecipient[]) => void
  people: AutomationPeopleResponse['people'] | null
  peopleMap: ReadonlyMap<string, AutomationPerson> | null
  roles: readonly Role[]
  /** A watch's known columns; null for a report (it has no cases). */
  columns: readonly string[] | null
  known: readonly AutomationRecipientView[]
  loading: boolean
}) {
  const views = recipientViews(value, peopleMap, known, columns)
  const chosen = new Set(value.map(recipientKey))
  const full = value.length >= AUTOMATION_MAX_RECIPIENTS
  // The people not chosen yet, by role.
  const groups = useMemo(() => {
    const taken = new Set(value.flatMap((r) => (r.kind === 'user' ? [r.userId] : [])))
    return groupByRole((people ?? []).filter((p) => !taken.has(p.id)))
  }, [people, value])
  const freeRoles = roles.filter((r) => !chosen.has(`role:${r}`))
  const freeColumns = (columns ?? []).filter((c) => !chosen.has(`column:${c}`))
  const add = (r: AutomationRecipient) => onChange([...value, r])
  const remove = (key: string) => onChange(value.filter((r) => recipientKey(r) !== key))

  return (
    <div className="space-y-2">
      {views.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-3 py-3 text-center text-xs text-muted dark:border-slate-700">Nobody yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Recipients">
          {views.map((r) => {
            const key = recipientKey(r)
            return (
              <li
                key={key}
                className={cn(
                  'inline-flex max-w-full items-center gap-1 rounded-lg py-1 pe-1 ps-2 text-xs font-semibold ring-1 ring-inset',
                  r.invalid ? 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25' : 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
                )}
                data-tip={r.invalid ? (r.kind === 'column' ? 'Not a column the query is known to return' : 'No longer an active account: it is skipped') : undefined}
              >
                <span dir="auto" className={cn('truncate', r.invalid && 'line-through decoration-rose-400')}>
                  {r.label}
                </span>
                {/* 28 px under a mouse; with a finger 36 px drawn and a 44 px target around it. */}
                <button
                  type="button"
                  onClick={() => remove(key)}
                  aria-label={`Remove ${r.label}`}
                  className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10 touch:h-9 touch:w-9 touch:before:absolute touch:before:-inset-1"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {views.some((r) => r.invalid) && (
        <p className="text-xs font-medium text-rose-700 dark:text-rose-300">Crossed out: no longer valid. Remove them before saving — the server refuses them.</p>
      )}
      <div className={cn('grid gap-2', columns ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        <Select
          aria-label="Add a person"
          value=""
          disabled={full || !people}
          onChange={(e) => e.target.value && add({ kind: 'user', userId: e.target.value })}
          className="min-h-[44px]"
        >
          <option value="">{loading ? 'Loading people…' : 'Add a person…'}</option>
          {groups.map(([role, list]) => (
            <optgroup key={role} label={roleName(role)}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.username})
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select aria-label="Add everyone with a role" value="" disabled={full || freeRoles.length === 0} onChange={(e) => e.target.value && add({ kind: 'role', role: e.target.value as Role })} className="min-h-[44px]">
          {/* Short, so it reads whole in a third of the drawer; the aria-label and the words above say it in full. */}
          <option value="">Add a role…</option>
          {freeRoles.map((r) => (
            <option key={r} value={r}>
              {ROLE_RECIPIENT_LABEL[r] ?? roleName(r)}
            </option>
          ))}
        </Select>
        {columns && (
          <Select aria-label="Add the people a column names" value="" disabled={full || freeColumns.length === 0} onChange={(e) => e.target.value && add({ kind: 'column', column: e.target.value })} className="min-h-[44px]">
            <option value="">{freeColumns.length === 0 ? 'No column to add' : 'Add a column…'}</option>
            {freeColumns.map((c) => (
              <option key={c} value={c}>
                People in "{c}"
              </option>
            ))}
          </Select>
        )}
      </div>
    </div>
  )
}
