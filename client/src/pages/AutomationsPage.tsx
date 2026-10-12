// ============================================================================
// §21 — the Automations page: the watches and scheduled reports set up
// through the assistant, for the people allowed to create them (the route and
// the server both see to it). A creator sees their own; the assistant's
// owner sees everyone's, with whose each is. Watches and scheduled reports
// are listed apart, each under its own heading. Each shows what it does, its
// state when it is not simply on (paused, failed — or blocked, and why),
// when it runs and runs next (factory time), how its last run went and the
// follow-ups it has open; one opens on its own page. Each has its on/off
// switch here (pause, resume), as on its page. New ones are made by asking the assistant: nothing is ever set
// up from here without a proposal someone activated.
// ============================================================================

import '@/components/ai/fonts'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CheckCircle2, ChevronRight, Clock, Eye, ListChecks, Loader2, OctagonX, Sparkles, Zap, type LucideIcon } from 'lucide-react'
import type { Automation } from '@qc/shared/automation'
import { Badge, Button, Card, EmptyState } from '@/components/ui'
import { FilterBar, FilterSelect, HeaderStat, InfoTip, type FilterChip } from '@/components/ui/PageShell'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'
import { ScrollX } from '@/components/ui/ScrollX'
import { Notice } from '@/components/ai/AiNotice'
import { AiSwitch } from '@/components/ai/AiSwitch'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { StatusBadge, errorLines } from '@/components/automations/parts'
import { automationStatus, automationSwitch, factoryMoment, factoryTimestamp, noNextRunText, whenText, type StatusView } from '@/components/automations/wording'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn } from '@/lib/utils'
import { pauseAutomation, recheckAccessOn404, resumeAutomation, useAutomations } from '@/services/automations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'

type KindFilter = 'all' | Automation['kind']
type StatusFilter = 'all' | StatusView['key']

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = { all: 'Any state', active: 'Active', blocked: 'Blocked', failed: 'Failed', paused: 'Paused' }
const KIND_FILTER_LABEL: Record<KindFilter, string> = { all: 'Every kind', watch: 'Watches', report: 'Scheduled reports' }

/** The page's two lists: watches first (they act on the floor as it happens), then the reports. */
interface ListSection {
  kind: Automation['kind']
  title: string
  hint: string
  icon: LucideIcon
}
const SECTIONS: readonly ListSection[] = [
  { kind: 'watch', title: 'Watches', hint: 'Look at the data every few minutes and act once on each new case.', icon: Eye },
  { kind: 'report', title: 'Scheduled reports', hint: 'Run at their set time, factory time, and send the result.', icon: CalendarClock },
]

/** What "New" writes in the assistant's box: the assistant takes it from there, in the person's own words. */
export const NEW_AUTOMATION_TEXT = 'Set up an automation: '

const ABOUT =
  'Ask the assistant, in your own words, to keep an eye on something ("tell the supervisors when a sample fails on line 3") or to send a report regularly ("every morning at 8, yesterday’s rejects by machine"). It proposes it as a card in the chat; nothing runs until you press Activate there.\n\nAutomations only tell people (the bell, the chat) and open follow-ups. They never change the record, and they read only the data their creator has.'

export function AutomationsPage() {
  const qc = useQueryClient()
  const ai = useAi()
  const navigate = useNavigate()
  const { factoryTimeZone } = useAuth()
  const owner = ai.owner
  const [term, setTerm] = useState('')
  const [kind, setKind] = usePersistedState<KindFilter>('qc-automations:kind', 'all')
  const [status, setStatus] = usePersistedState<StatusFilter>('qc-automations:status', 'all')
  const [creator, setCreator] = usePersistedState('qc-automations:creator', '')
  const { data, isLoading, isError, error, refetch, isFetching } = useAutomations(null)

  useEffect(() => recheckAccessOn404(qc, error), [qc, error])

  const all = useMemo(() => data ?? [], [data])
  const creators = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of all) seen.set(a.creator.id, a.creator.name)
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [all])
  // The owner's filter by person; a creator's list is theirs alone anyway.
  const byCreator = owner && creator && creators.some((c) => c.id === creator) ? creator : ''

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase()
    return all.filter((a) => {
      if (kind !== 'all' && a.kind !== kind) return false
      if (status !== 'all' && automationStatus(a).key !== status) return false
      if (byCreator && a.creator.id !== byCreator) return false
      if (q && !`${a.name}\n${a.description}\n${a.creator.name}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [all, term, kind, status, byCreator])

  // The table's columns (its state and creator sit under the name, its kind is its list; the Kind, State and Created by selects sift those).
  const view = useTableView(filtered, [
    { key: 'name', value: (a) => a.name },
    { key: 'when', value: (a) => whenText(a) },
    { key: 'next', value: (a) => (a.nextRunAt ? factoryMoment(a.nextRunAt, factoryTimeZone) : noNextRunText(automationStatus(a))), sortValue: (a) => (a.nextRunAt ? Date.parse(a.nextRunAt) : null), numeric: true },
    { key: 'last', value: (a) => (a.lastRunAt ? `${factoryMoment(a.lastRunAt, factoryTimeZone)} · ${a.lastRunOk === false ? 'failed' : 'worked'}` : 'Never'), sortValue: (a) => (a.lastRunAt ? Date.parse(a.lastRunAt) : null), numeric: true },
    { key: 'followUps', value: (a) => String(a.openFollowUps), sortValue: (a) => a.openFollowUps, numeric: true },
  ])

  const filtersSet = term !== '' || kind !== 'all' || status !== 'all' || byCreator !== ''
  const reset = () => {
    setTerm('')
    setKind('all')
    setStatus('all')
    setCreator('')
    view.clear()
  }
  const chips: FilterChip[] = [
    ...(kind !== 'all' ? [{ key: 'kind', label: KIND_FILTER_LABEL[kind], onRemove: () => setKind('all') }] : []),
    ...(status !== 'all' ? [{ key: 'status', label: `State: ${STATUS_FILTER_LABEL[status]}`, onRemove: () => setStatus('all') }] : []),
    ...(byCreator ? [{ key: 'creator', label: `Created by ${creators.find((c) => c.id === byCreator)?.name ?? 'one person'}`, onRemove: () => setCreator('') }] : []),
  ]

  const states = useMemo(() => {
    const n: Record<StatusView['key'], number> = { active: 0, paused: 0, failed: 0, blocked: 0 }
    for (const a of all) n[automationStatus(a).key]++
    return n
  }, [all])
  const startNew = () => ai.compose(NEW_AUTOMATION_TEXT)

  return (
    <div className="ai-type space-y-3">
      <FilterBar
        search={{ value: term, onChange: setTerm, placeholder: owner ? 'Name, description or creator…' : 'Name or description…', label: 'Search automations' }}
        filters={
          <>
            <FilterSelect label="Kind" value={kind} onChange={(v) => setKind(v as KindFilter)}>
              {(Object.keys(KIND_FILTER_LABEL) as KindFilter[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_FILTER_LABEL[k]}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="State" value={status} onChange={(v) => setStatus(v as StatusFilter)}>
              {(Object.keys(STATUS_FILTER_LABEL) as StatusFilter[]).map((k) => (
                <option key={k} value={k}>
                  {STATUS_FILTER_LABEL[k]}
                </option>
              ))}
            </FilterSelect>
            {owner && (
              <FilterSelect label="Created by" value={byCreator} onChange={setCreator}>
                <option value="">Everyone</option>
                {creators.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </FilterSelect>
            )}
          </>
        }
        actions={
          <>
            <InfoTip text={ABOUT} label="About automations" />
            {ai.enabled && (
              <Button variant="primary" className="h-10 min-h-0 py-0 text-13 touch:h-11" onClick={startNew} data-tip="Opens the assistant in a new conversation: describe what to watch or report">
                <Sparkles className="h-4 w-4" /> New in the assistant
              </Button>
            )}
          </>
        }
        chips={chips}
        onReset={reset}
        canReset={filtersSet || view.active > 0}
      />

      {isLoading ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : isError && !data ? (
        <Notice tone="red" action={<Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void refetch()}>Try again</Button>}>
          The automations could not be loaded.
        </Notice>
      ) : all.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-10 w-10" />}
          title="No automations yet"
          hint="Ask the assistant to keep an eye on something — “tell me when a sample fails on line 3” — or to send a report every morning. It proposes it as a card in the chat; nothing runs until you press Activate."
          action={
            ai.enabled ? (
              <Button variant="primary" className="min-h-[44px]" onClick={startNew}>
                <Sparkles className="h-4 w-4" /> New in the assistant
              </Button>
            ) : undefined
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Zap className="h-10 w-10" />} title="No automation matches" hint="Clear the search or the filters to see them all." />
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-13 text-muted">
            <span>
              <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{view.rows.length.toLocaleString()}</span>
              {view.rows.length !== all.length && <> of {all.length.toLocaleString()}</>} {all.length === 1 ? 'automation' : 'automations'}
            </span>
            <span aria-hidden>·</span>
            <HeaderStat value={states.active} label="active" tone="success" onClick={() => setStatus('active')} tip="Show the active ones" />
            {(['failed', 'blocked', 'paused'] as const).map((k) =>
              states[k] > 0 ? (
                <span key={k} className="inline-flex items-center gap-x-3">
                  <span aria-hidden>·</span>
                  <HeaderStat value={states[k]} label={STATUS_FILTER_LABEL[k].toLowerCase()} onClick={() => setStatus(k)} tip={`Show the ${STATUS_FILTER_LABEL[k].toLowerCase()} ones`} />
                </span>
              ) : null,
            )}
            {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Refreshing" />}
          </p>

          {SECTIONS.filter((sec) => kind === 'all' || kind === sec.kind).map((sec) => {
            const rows = view.rows.filter((a) => a.kind === sec.kind)
            if (rows.length === 0) return null
            return (
              <section key={sec.kind} aria-labelledby={`automations-${sec.kind}`} className="space-y-2">
                <SectionHeading id={`automations-${sec.kind}`} section={sec} count={rows.length} />

                {/* Phones and tablets: a card each — two across from 640 px, three from 1024. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:hidden">
                  {rows.map((a) => (
                    <AutomationCard key={a.id} a={a} owner={owner} timeZone={factoryTimeZone} />
                  ))}
                </div>

                {/* From xl (1280 px): one line each, its columns set so nothing floats apart; the name keeps its place
                    while the rest scrolls under it beside the docked assistant. */}
                <Card className="hidden overflow-hidden xl:block">
                  <ScrollX shadows="end" label={sec.title}>
                    <table className="table-sticky-first w-full min-w-[60rem] table-fixed text-sm">
                      <colgroup>
                        <col />
                        <col className="w-[15rem]" />
                        <col className="w-[9.5rem]" />
                        <col className="w-[10rem]" />
                        <col className="w-[7.5rem]" />
                        <col className="w-[4.5rem]" />
                      </colgroup>
                      <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-muted dark:bg-slate-800/60">
                        <tr>
                          <ViewTh view={view} column="name" label="Name" className="bg-slate-50 px-4 py-2.5 font-semibold dark:bg-slate-800/60" />
                          <ViewTh view={view} column="when" label={sec.kind === 'watch' ? 'Looks' : 'Runs'} className="px-3 py-2.5 font-semibold" />
                          <ViewTh view={view} column="next" label="Next run" className="px-3 py-2.5 font-semibold" />
                          <ViewTh view={view} column="last" label="Last run" className="px-3 py-2.5 font-semibold" />
                          <ViewTh view={view} column="followUps" label="Follow-ups" className="px-3 py-2.5 text-center font-semibold" />
                          <th className="px-4 py-2.5 text-right font-semibold">On</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {rows.map((a) => (
                          <tr key={a.id} onClick={() => navigate(`/automations/${encodeURIComponent(a.id)}`)} className="data-row group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60">
                            <td className="px-4 py-3">
                              <NameCell a={a} owner={owner} />
                            </td>
                            <td className="px-3 py-3 text-13 text-slate-600 dark:text-slate-300">
                              <span className="flex items-start gap-1.5">
                                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                                <span className="min-w-0">{whenText(a)}</span>
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 text-13 tabular-nums">
                              <NextRun a={a} timeZone={factoryTimeZone} />
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 text-13 tabular-nums">
                              <LastRun a={a} timeZone={factoryTimeZone} />
                            </td>
                            <td className="px-3 py-3 text-center">
                              <FollowUpCount n={a.openFollowUps} />
                            </td>
                            <td className="px-4 py-3 text-right">
                              <AutomationSwitch a={a} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollX>
                </Card>
              </section>
            )
          })}
          <div className="hidden xl:block">
            <ViewNote view={view} total={filtered.length} />
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Its on/off switch: off pauses it, on resumes it (a stopped one starts over,
 * its failures forgotten) — as its page's Pause and Resume, audited alike.
 * Pressing it never opens the automation, as the rest of its row does.
 */
function AutomationSwitch({ a }: { a: Automation }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const sw = automationSwitch(a)
  const flip = async () => {
    setBusy(true)
    try {
      if (sw.action === 'pause') {
        await pauseAutomation(qc, a.id)
        toast(`“${a.name}” is paused. The change is in the audit log.`, 'success')
      } else {
        await resumeAutomation(qc, a.id)
        toast(`“${a.name}” is on again. The change is in the audit log.`, 'success')
      }
    } catch (e) {
      recheckAccessOn404(qc, e)
      toast(errorLines(e, 'That did not work.').join(' '), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    // Its click (a key's too) stays here: the row around it opens the automation.
    <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <AiSwitch on={sw.on} onChange={() => void flip()} label={`On: ${a.name}`} tip={sw.tip} disabled={busy} />
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" aria-label="Saving" />}
    </span>
  )
}

/** A list's heading: what its automations do, and how many there are. */
function SectionHeading({ id, section, count }: { id: string; section: ListSection; count: number }) {
  const Icon = section.icon
  return (
    <div className="flex items-center gap-3 px-1 pt-2">
      <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <h2 id={id} className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-slate-100">
          {section.title}
          <span className="rounded-full bg-slate-200/80 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-700 dark:text-slate-300">{count}</span>
        </h2>
        <p className="text-xs text-muted">{section.hint}</p>
      </div>
    </div>
  )
}

/**
 * The name, what it does in a line, and — only when it is not simply on — its
 * state; the owner also reads whose it is. Written left to right like the
 * rest of the list, an Arabic name keeps its own reading order.
 */
function NameCell({ a, owner }: { a: Automation; owner: boolean }) {
  const s = automationStatus(a)
  return (
    <div className="min-w-0">
      {/* With a finger the name is plain text: the whole row opens the automation, as the link does. */}
      <Link
        to={`/automations/${encodeURIComponent(a.id)}`}
        onClick={(e) => e.stopPropagation()}
        dir="auto"
        className="block truncate text-left font-semibold text-slate-800 [unicode-bidi:plaintext] hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-300 touch:pointer-events-none"
        data-tip={a.name}
      >
        {a.name}
      </Link>
      {a.description && (
        <p dir="auto" className="mt-0.5 truncate text-left text-xs text-muted [unicode-bidi:plaintext]" data-tip={a.description}>
          {a.description}
        </p>
      )}
      {(s.key !== 'active' || owner) && (
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {s.key !== 'active' && <StatusBadge automation={a} />}
          {owner && (
            <span dir="auto" className="min-w-0 truncate text-[11px] text-muted">
              by {a.creator.name}
            </span>
          )}
        </span>
      )}
    </div>
  )
}

/** Its open follow-ups: a badge when there are some, a dash when none. */
function FollowUpCount({ n }: { n: number }) {
  if (n === 0) return <span className="text-muted">—</span>
  return (
    <Badge tone="amber" icon={<ListChecks className="h-3 w-3" />} tip={`${n} open follow-up${n === 1 ? '' : 's'}`}>
      {n.toLocaleString()}
    </Badge>
  )
}

/** When it runs next, in factory time; or why it does not. */
function NextRun({ a, timeZone }: { a: Automation; timeZone: string }) {
  if (!a.nextRunAt) return <span className="text-muted">{noNextRunText(automationStatus(a))}</span>
  return (
    <time dateTime={a.nextRunAt} data-tip={factoryTimestamp(a.nextRunAt, timeZone)}>
      {factoryMoment(a.nextRunAt, timeZone)}
    </time>
  )
}

/** When it last ran: a green tick when it worked; a failed one says so in words, as well as by its icon. */
function LastRun({ a, timeZone }: { a: Automation; timeZone: string }) {
  if (!a.lastRunAt) return <span className="text-muted">Never</span>
  const failed = a.lastRunOk === false
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5" data-tip={`${factoryTimestamp(a.lastRunAt, timeZone)} · ${failed ? (a.lastRunError ?? 'failed') : 'worked'}`}>
      {failed ? <OctagonX className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" aria-label="Failed" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-label="Worked" />}
      <time dateTime={a.lastRunAt}>{factoryMoment(a.lastRunAt, timeZone)}</time>
      {failed && <span className="text-xs font-semibold text-rose-700 dark:text-rose-300">Failed</span>}
    </span>
  )
}

function AutomationCard({ a, owner, timeZone }: { a: Automation; owner: boolean; timeZone: string }) {
  const s = automationStatus(a)
  const sw = automationSwitch(a)
  // The switch sits under the link, not in it: a control inside a link is no control at all.
  return (
    <div className="card-hover w-full min-w-0 overflow-hidden">
      <Link to={`/automations/${encodeURIComponent(a.id)}`} className="block w-full min-w-0 p-4 text-left">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {s.key !== 'active' && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <StatusBadge automation={a} />
              </div>
            )}
            <p dir="auto" className="break-words text-left font-bold [unicode-bidi:plaintext]">
              {a.name}
            </p>
          </div>
          <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-muted rtl:rotate-180" />
        </div>
        <p dir="auto" className="mt-0.5 line-clamp-2 text-left text-xs text-muted [unicode-bidi:plaintext]">
          {a.description}
        </p>
        {s.key === 'blocked' || s.key === 'failed' ? <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-300">{s.tip}</p> : null}
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <div className="col-span-2">
            <dt className="sr-only">Runs</dt>
            <dd className="flex items-start gap-1.5 text-slate-600 dark:text-slate-300">
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              {whenText(a)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Next run</dt>
            <dd className="tabular-nums">
              <NextRun a={a} timeZone={timeZone} />
            </dd>
          </div>
          <div>
            <dt className="text-muted">Last run</dt>
            <dd className="tabular-nums">
              <LastRun a={a} timeZone={timeZone} />
            </dd>
          </div>
        </dl>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          {a.openFollowUps > 0 && (
            <Badge tone="amber" icon={<ListChecks className="h-3 w-3" />}>
              {a.openFollowUps} open follow-up{a.openFollowUps === 1 ? '' : 's'}
            </Badge>
          )}
          {owner && (
            <span dir="auto" className="truncate">
              by {a.creator.name}
            </span>
          )}
        </div>
      </Link>
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2 dark:border-slate-800">
        <span className="text-xs font-semibold text-muted">{sw.on ? 'On' : 'Off'}</span>
        <AutomationSwitch a={a} />
      </div>
    </div>
  )
}
