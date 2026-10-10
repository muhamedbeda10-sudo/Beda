// ============================================================================
// §21 — Follow-ups: what watches opened for people to look into. Everyone
// sees the ones given to them and the ones their own automations opened
// ("Mine"); supervisors, administrators and the assistant's owner may see
// everyone's ("Everyone's"). Overdue first, then by deadline, 50 a page.
// The filters the server answers (whose, status, overdue, automation) sit in
// the row; Excel's column menus sift the rows loaded. One opens in a drawer
// over the list (/follow-ups/<id>), where it is worked and closed.
// ============================================================================

// The titles automations write may be Arabic: the assistant's Arabic face, fetched only when an Arabic letter is drawn.
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css'
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css'
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ChevronRight, ListChecks, Loader2, MessageSquareText, UserRound, Users } from 'lucide-react'
import type { FollowUp, FollowUpScope } from '@qc/shared/automation'
import { Badge, Button, Card, EmptyState } from '@/components/ui'
import { FilterBar, FilterSelect, HeaderStat, InfoTip, Segmented, StatDot, type FilterChip } from '@/components/ui/PageShell'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'
import { FollowUpDrawer } from '@/components/followUps/FollowUpDrawer'
import { DueText, FollowUpStatusBadge } from '@/components/followUps/parts'
import {
  FOLLOW_UP_STATUS_LABEL,
  STATUS_FILTER_LABEL,
  automationLinkFilters,
  emptyListWords,
  factoryMoment,
  followUpLinks,
  isOverdue,
  isStatusFilter,
  type FollowUpFilters,
  type FollowUpStatusFilter,
} from '@/components/followUps/wording'
import { usePersistedState } from '@/lib/usePersistedState'
import { cn } from '@/lib/utils'
import { textDirection } from '@/lib/direction'
import { useFollowUpCounts, useFollowUps } from '@/services/followUps'
import { useAuth } from '@/store/AuthContext'

/** An automation the list can be narrowed to, with the name it is shown by. */
interface AutomationPick {
  id: string
  name: string
}

const STATUS_ORDER = { open: 0, in_progress: 1, done: 2 } as const

/** A follow-up opened from the list says so, so closing it steps back to the list instead of adding a step. */
const FROM_LIST = { fromList: true } as const

const ABOUT =
  'A watch opens a follow-up for each new case it finds, with someone to look into it and a deadline. Move it to In progress while you work on it and close it with a note when it is dealt with; comments reach the people on it. A follow-up past its deadline is overdue and goes to the automation’s creator once.\n\nAn inspection session with a follow-up not done reads “Needs review” in History until it is closed.'

export function FollowUpsPage() {
  const { id = null } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const { factoryTimeZone: tz } = useAuth()
  const { data: counts, isError: countsFailed } = useFollowUpCounts()
  const [term, setTerm] = useState('')
  const [scope, setScope] = usePersistedState<FollowUpScope>('qc-follow-ups:scope', 'mine')
  const [status, setStatus] = usePersistedState<FollowUpStatusFilter>('qc-follow-ups:status', 'active')
  const [overdueOnly, setOverdueOnly] = usePersistedState('qc-follow-ups:overdue', false)
  const [automation, setAutomation] = usePersistedState<AutomationPick | null>('qc-follow-ups:automation', null)

  // "Everyone's" is there only for those who may see it; anyone else's list is theirs whatever was kept.
  const mayAll = counts?.all ?? false
  // The list waits for the counts, which say whether "Everyone's" is this person's to ask for.
  const countsSettled = counts !== undefined || countsFailed
  const fromAutomation = params.get('automationId')

  // An automation's page sends its id in the address: it becomes the filter, once, and leaves the address. Its
  // "N open" counts all of that automation's follow-ups, so those who may see everyone's see everyone's.
  useEffect(() => {
    if (fromAutomation === null || !countsSettled) return
    const linked = automationLinkFilters(mayAll)
    if (fromAutomation) setAutomation((prev) => (prev?.id === fromAutomation ? prev : { id: fromAutomation, name: '' }))
    setScope(linked.scope)
    setStatus(linked.status)
    setOverdueOnly(linked.overdue)
    const next = new URLSearchParams(params)
    next.delete('automationId')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromAutomation, countsSettled])
  const filters = useMemo<FollowUpFilters>(
    () => ({ scope: mayAll && scope === 'all' ? 'all' : 'mine', status: isStatusFilter(status) ? status : 'active', overdue: overdueOnly === true, automationId: automation?.id ?? null }),
    [mayAll, scope, status, overdueOnly, automation?.id],
  )
  // …and, arriving from an automation, for its filters to be set: the list is asked for once, as it will be shown.
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetching } = useFollowUps(filters, countsSettled && fromAutomation === null)

  const loaded = useMemo(() => {
    const seen = new Set<string>()
    const out: FollowUp[] = []
    for (const page of data?.pages ?? []) {
      for (const f of page.followUps) {
        if (seen.has(f.id)) continue
        seen.add(f.id)
        out.push(f)
      }
    }
    return out
  }, [data])

  // The automation filter's name comes from its follow-ups once they are loaded.
  useEffect(() => {
    if (!automation || automation.name) return
    const named = loaded.find((f) => f.automationId === automation.id)
    if (named) setAutomation({ id: automation.id, name: named.automationName })
  }, [automation, loaded, setAutomation])

  const automations = useMemo(() => {
    const seen = new Map<string, string>()
    for (const f of loaded) if (f.automationId) seen.set(f.automationId, f.automationName)
    if (automation && !seen.has(automation.id)) seen.set(automation.id, automation.name || 'This automation')
    return [...seen].map(([aid, name]) => ({ id: aid, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [loaded, automation])

  const searched = useMemo(() => {
    const q = term.trim().toLowerCase()
    if (!q) return loaded
    return loaded.filter((f) =>
      [f.title, f.body, f.automationName, f.assignee?.name ?? '', f.sessionLabel ?? '', f.orderNumber ?? '', f.caseKey].some((t) => t.toLowerCase().includes(q)),
    )
  }, [loaded, term])

  const view = useTableView(searched, [
    { key: 'title', value: (f) => f.title, noValues: true },
    { key: 'automation', value: (f) => f.automationName },
    { key: 'assignee', value: (f) => f.assignee?.name ?? 'Nobody' },
    { key: 'due', value: (f) => factoryMoment(f.dueAt, tz), sortValue: (f) => Date.parse(f.dueAt), numeric: true },
    { key: 'status', value: (f) => (isOverdue(f) ? 'Overdue' : FOLLOW_UP_STATUS_LABEL[f.status]), sortValue: (f) => (isOverdue(f) ? -1 : STATUS_ORDER[f.status]) },
    { key: 'linked', value: (f) => f.sessionLabel ?? f.orderNumber ?? '' },
    { key: 'updated', value: (f) => factoryMoment(f.updatedAt, tz), sortValue: (f) => Date.parse(f.updatedAt), numeric: true },
    { key: 'comments', value: (f) => String(f.commentCount), sortValue: (f) => f.commentCount, numeric: true },
  ])

  const filtersSet = term !== '' || status !== 'active' || overdueOnly || automation !== null
  // Nothing left to do here: whether any are done says which is so — all of them done, or none yet at all.
  const nothingActive = countsSettled && fromAutomation === null && !isLoading && !isError && loaded.length === 0 && !filtersSet && filters.status === 'active'
  const doneCheck = useFollowUps({ ...filters, status: 'done' }, nothingActive)
  const empty = emptyListWords({ filtersSet, status: filters.status, scope: filters.scope, anyDone: doneCheck.isError ? null : (doneCheck.data?.pages[0]?.followUps.length ?? 0) > 0 })
  const reset = () => {
    setTerm('')
    setStatus('active')
    setOverdueOnly(false)
    setAutomation(null)
    view.clear()
  }
  const chips: FilterChip[] = [
    ...(status !== 'active' ? [{ key: 'status', label: `Status: ${STATUS_FILTER_LABEL[status]}`, onRemove: () => setStatus('active') }] : []),
    ...(overdueOnly ? [{ key: 'overdue', label: 'Overdue only', onRemove: () => setOverdueOnly(false) }] : []),
    ...(automation ? [{ key: 'automation', label: `Automation: ${automation.name || 'one automation'}`, onRemove: () => setAutomation(null) }] : []),
  ]
  const showMineOverdue = () => {
    setScope('mine')
    setStatus('active')
    setOverdueOnly(true)
  }
  const open = (f: FollowUp) => navigate(`/follow-ups/${encodeURIComponent(f.id)}`, { state: FROM_LIST })
  // Opened from the list: back to it. Opened from an alert or a link: the list takes its place.
  const closeDrawer = () => ((location.state as typeof FROM_LIST | null)?.fromList ? navigate(-1) : navigate('/follow-ups', { replace: true }))
  const nothingYet = counts !== undefined && !counts.visible && loaded.length === 0 && !filtersSet

  return (
    <div className="ai-type space-y-3">
      <FilterBar
        leading={
          mayAll ? (
            <Segmented
              label="Whose follow-ups"
              value={filters.scope}
              onChange={setScope}
              options={[
                { value: 'mine', label: 'Mine', icon: <UserRound className="h-4 w-4" /> },
                { value: 'all', label: 'Everyone’s', icon: <Users className="h-4 w-4" /> },
              ]}
            />
          ) : undefined
        }
        search={{ value: term, onChange: setTerm, placeholder: 'Title, automation, person, order or session…', label: 'Search follow-ups' }}
        filters={
          <>
            <FilterSelect label="Status" value={filters.status} onChange={(v) => setStatus(isStatusFilter(v) ? v : 'active')}>
              {(Object.keys(STATUS_FILTER_LABEL) as FollowUpStatusFilter[]).map((k) => (
                <option key={k} value={k}>
                  {STATUS_FILTER_LABEL[k]}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Deadline" value={overdueOnly ? 'overdue' : 'any'} onChange={(v) => setOverdueOnly(v === 'overdue')}>
              <option value="any">Any deadline</option>
              <option value="overdue">Overdue only</option>
            </FilterSelect>
            {automations.length > 0 && (
              <FilterSelect
                label="Automation"
                value={automation?.id ?? ''}
                onChange={(v) => setAutomation(v ? (automations.find((a) => a.id === v) ?? { id: v, name: '' }) : null)}
              >
                <option value="">Every automation</option>
                {automations.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </FilterSelect>
            )}
          </>
        }
        actions={<InfoTip text={ABOUT} label="About follow-ups" />}
        chips={chips}
        onReset={reset}
        canReset={filtersSet || view.active > 0}
      />

      {isLoading || !countsSettled || fromAutomation !== null || (nothingActive && doneCheck.isLoading) ? (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      ) : isError && !data ? (
        <Card className="p-6">
          <EmptyState icon={<ListChecks className="h-10 w-10" />} title="The follow-ups could not be loaded" hint="Check the connection and try again." action={<Button onClick={() => void refetch()}>Try again</Button>} />
        </Card>
      ) : nothingYet ? (
        <EmptyState icon={<ListChecks className="h-10 w-10" />} title="No follow-ups for you" hint="When an automation opens a follow-up for you to look into, it shows here — and in your alerts." />
      ) : searched.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-10 w-10" />}
          title={empty.title}
          hint={empty.hint}
          action={
            mayAll && filters.scope === 'mine' ? (
              <Button onClick={() => setScope('all')} className="min-h-[44px]">
                <Users className="h-4 w-4" /> See everyone’s
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Phone: a card each. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
            {view.rows.map((f) => (
              <FollowUpCard key={f.id} f={f} active={f.id === id} timeZone={tz} />
            ))}
          </div>

          {/* md+: one line each; what does not fit is in the tooltips. Sized so the columns fit a 1366 px laptop. */}
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[64rem] text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  <ViewTh view={view} column="title" label="Follow-up" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="automation" label="Automation" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="assignee" label="Assigned to" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="due" label="Deadline" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="status" label="Status" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="linked" label="Session or order" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="updated" label="Updated" className="px-3 py-2 font-semibold" />
                  <ViewTh view={view} column="comments" label="Comments" className="px-3 py-2 text-right font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {view.rows.map((f) => (
                  <tr
                    key={f.id}
                    onClick={() => open(f)}
                    aria-selected={f.id === id}
                    className={cn('data-row cursor-pointer', f.id === id ? 'bg-info-50 dark:bg-[#16233f]' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60')}
                  >
                    <td className="max-w-[18rem] px-3 py-2">
                      <Link
                        to={`/follow-ups/${encodeURIComponent(f.id)}`}
                        state={FROM_LIST}
                        onClick={(e) => e.stopPropagation()}
                        dir={textDirection(f.title) ?? 'auto'}
                        data-tip={f.body || f.title}
                        className="block truncate font-semibold text-slate-800 hover:text-brand-700 hover:underline dark:text-slate-100 dark:hover:text-brand-300"
                      >
                        {f.title}
                      </Link>
                    </td>
                    <td className="max-w-[11rem] truncate px-3" dir="auto" data-tip={f.automationName}>
                      {f.automationName}
                    </td>
                    <td className="max-w-[9rem] truncate px-3" dir="auto">
                      {f.assignee?.name ?? <span className="text-muted">Nobody</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <DueText followUp={f} timeZone={tz} stacked />
                    </td>
                    <td className="whitespace-nowrap px-3">
                      <StatusChips f={f} />
                    </td>
                    <td className="max-w-[11rem] px-3">
                      <LinkedRecord f={f} />
                    </td>
                    <td className="whitespace-nowrap px-3 tabular-nums text-slate-600 dark:text-slate-300">{factoryMoment(f.updatedAt, tz)}</td>
                    <td className={cn('px-3 text-right tabular-nums', f.commentCount === 0 && 'text-muted')}>{f.commentCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ViewNote view={view} total={searched.length} />
          </Card>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 text-13 text-muted">
            <span>
              <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{view.rows.length.toLocaleString()}</span>
              {view.rows.length !== loaded.length && <> of {loaded.length.toLocaleString()}</>} {loaded.length === 1 ? 'follow-up' : 'follow-ups'}
              {hasNextPage && ' loaded'}
            </span>
            {counts && counts.mineOpen > 0 && (
              <>
                <StatDot />
                <HeaderStat value={counts.mineOpen} label="open for you" />
              </>
            )}
            {counts && counts.mineOverdue > 0 && (
              <>
                <StatDot />
                <button type="button" onClick={showMineOverdue} className="rounded font-semibold text-rose-600 underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-rose-400" data-tip="Show your overdue ones">
                  {counts.mineOverdue} overdue
                </button>
              </>
            )}
            {hasNextPage && (
              <button type="button" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} className="btn-secondary h-8 min-h-0 px-3 py-0 text-13 touch:h-11">
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            )}
            {isFetching && !isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Refreshing" />}
          </div>
        </>
      )}

      <FollowUpDrawer id={id} onClose={closeDrawer} />
    </div>
  )
}

/** Its status, and what is wrong with it: overdue — escalated, as the overdue mark's sign. */
function StatusChips({ f }: { f: FollowUp }) {
  const overdue = isOverdue(f)
  const escalated = !!f.escalatedAt && f.status !== 'done'
  return (
    <span className="inline-flex items-center gap-1.5">
      <FollowUpStatusBadge status={f.status} />
      {overdue && (
        <Badge tone="red" icon={escalated ? <AlertTriangle className="h-3 w-3" aria-hidden /> : undefined} tip={escalated ? 'Past its deadline, and escalated to the automation’s creator' : undefined}>
          Overdue{escalated && <span className="sr-only"> and escalated</span>}
        </Badge>
      )}
      {escalated && !overdue && (
        <span data-tip="Escalated to the automation’s creator" className="text-rose-600 dark:text-rose-400">
          <AlertTriangle className="h-3.5 w-3.5" aria-label="Escalated" />
        </span>
      )}
    </span>
  )
}

/** The session it concerns (in History), or else its order. */
function LinkedRecord({ f }: { f: FollowUp }) {
  const links = followUpLinks(f)
  const to = links.session ?? links.order
  if (!to) return <span className="text-muted">—</span>
  const label = links.session ? (f.sessionLabel ?? 'Session') : f.orderNumber
  return (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      dir="auto"
      data-tip={links.session ? 'Open the session in History' : 'This order’s sessions in History'}
      className="block truncate text-brand-700 underline-offset-4 hover:underline dark:text-brand-300"
    >
      {label}
    </Link>
  )
}

function FollowUpCard({ f, active, timeZone }: { f: FollowUp; active: boolean; timeZone: string }) {
  return (
    <Link to={`/follow-ups/${encodeURIComponent(f.id)}`} state={FROM_LIST} className={cn('card-hover block w-full min-w-0 p-4 text-left', active && 'ring-2 ring-brand-400')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <StatusChips f={f} />
          <p dir={textDirection(f.title) ?? 'auto'} className="mt-1.5 break-words text-start font-bold">
            {f.title}
          </p>
        </div>
        <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-muted rtl:rotate-180" />
      </div>
      <p dir="auto" className="mt-0.5 truncate text-xs text-muted">
        {f.automationName}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div className="min-w-0">
          <dt className="text-muted">Deadline</dt>
          <dd>
            <DueText followUp={f} timeZone={timeZone} stacked />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted">Assigned to</dt>
          <dd dir="auto" className="truncate">
            {f.assignee?.name ?? 'Nobody'}
          </dd>
        </div>
        {(f.sessionLabel || f.orderNumber) && (
          <div className="col-span-2 min-w-0">
            <dt className="sr-only">Session or order</dt>
            <dd dir="auto" className="truncate text-slate-600 dark:text-slate-300">
              {f.sessionLabel ?? f.orderNumber}
            </dd>
          </div>
        )}
      </dl>
      {f.commentCount > 0 && (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted">
          <MessageSquareText className="h-3.5 w-3.5" /> {f.commentCount} comment{f.commentCount === 1 ? '' : 's'}
        </p>
      )}
    </Link>
  )
}
