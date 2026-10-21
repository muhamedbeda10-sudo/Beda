// ============================================================================
// §25 — Delivery date: a customer asks "when could you deliver N of X?", and
// the sales person needs the day now. The order's items are laid on the
// plan — the published one when there is one — through each item's learnt
// route and pace, and the plan is worked out again: the day its last line
// finishes taken in its turn, the day rushed ahead of everything, each
// step's machine and times, and what it does to the orders already planned.
// For an order that must be done by a day — new, or on the sheet — the
// advice tries what a planner would (rush, Fridays, more hours, freer
// machines, all of it), says which options meet the day and what each
// costs. Nothing is kept until "Keep as a scenario".
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CalendarCheck, Check, Lightbulb, Plus, Save, Trash2, X } from 'lucide-react'
import { PROCESS_NAMES, type AdviceOption, type AdviseResponse, type ItemRoute, type LineChange, type PlanEvent, type QuoteLine, type QuoteOutcome, type QuoteRequest, type QuoteResponse } from '@qc/shared/planning'
import { Badge, Button, EmptyState, Input } from '@/components/ui'
import { Segmented } from '@/components/ui/PageShell'
import { calendarDay } from '@qc/shared/rules'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'
import { useAdvise, useCreatePlan, usePlans, useQuote, useRoutes } from '@/services/planning'
import { DataGrid, ErrorNote, Loading, PartFooter, PartFrame, Scroller, useGrid, type GridColumn } from './common'
import { DURATION_NAME, dayLabel, hoursLabel, tonnes, wallLabel } from './format'

interface ItemDraft {
  key: number
  itemCode: string
  qty: string
}

let seq = 1
const blankItem = (): ItemDraft => ({ key: seq++, itemCode: '', qty: '' })

/** The lines of a quote's outcome, with Excel's filters. */
function QuoteLines({ outcome, caption }: { outcome: QuoteOutcome; caption: string }) {
  const columns = useMemo<GridColumn<QuoteLine>[]>(
    () => [
      { key: 'item', label: 'Item', value: (l) => l.item, cell: (l) => <span className="font-semibold">{l.item}</span> },
      { key: 'process', label: 'Process', value: (l) => (l.process ? PROCESS_NAMES[l.process] : '—'), cell: (l) => (l.process ? PROCESS_NAMES[l.process] : '—') },
      { key: 'machine', label: 'Machine', value: (l) => l.machineName, cell: (l) => l.machineName },
      { key: 'qty', label: 'Pieces', numeric: true, right: true, value: (l) => String(l.qty), sortValue: (l) => l.qty, cell: (l) => l.qty.toLocaleString() },
      {
        key: 'hours',
        label: 'Hours',
        numeric: true,
        right: true,
        value: (l) => String(l.hours),
        sortValue: (l) => l.hours,
        cell: (l) => (
          <span title={DURATION_NAME[l.durationSource]}>
            {hoursLabel(l.hours)}
            {l.durationSource === 'assumed' ? <span className="text-warning-800 dark:text-warning-400"> (assumed)</span> : ''}
          </span>
        ),
      },
      { key: 'start', label: 'Starts', value: (l) => wallLabel(l.start), sortValue: (l) => l.start, noValues: true, cell: (l) => wallLabel(l.start), className: 'whitespace-nowrap' },
      {
        key: 'end',
        label: 'Finishes',
        value: (l) => wallLabel(l.end),
        sortValue: (l) => l.end,
        noValues: true,
        cell: (l) => (l.end === null ? <span className="font-semibold text-danger-700 dark:text-danger-400">Not placed</span> : wallLabel(l.end)),
        className: 'whitespace-nowrap',
      },
      {
        key: 'late',
        label: 'Days late',
        numeric: true,
        right: true,
        value: (l) => String(l.lateDays),
        sortValue: (l) => l.lateDays,
        cell: (l) => (l.lateDays > 0 ? <span className="font-semibold text-danger-700 dark:text-danger-400">{l.lateDays} d</span> : '—'),
      },
    ],
    [],
  )
  const view = useGrid(outcome.lines, columns)
  return (
    <DataGrid
      view={view}
      columns={columns}
      rowKey={(l) => l.lineKey}
      total={outcome.lines.length}
      noun="steps"
      caption={caption}
      empty={<EmptyState title="Nothing planned" hint="No item could be planned." />}
    />
  )
}

function Impacted({ rows }: { rows: LineChange[] }) {
  const columns = useMemo<GridColumn<LineChange>[]>(
    () => [
      { key: 'order', label: 'Order', value: (c) => c.orderNumber, cell: (c) => <span className="font-semibold">{c.orderNumber}</span>, className: 'whitespace-nowrap' },
      {
        key: 'item',
        label: 'Item',
        value: (c) => c.item,
        noValues: true,
        cell: (c) => (
          <span className="block max-w-[220px] truncate" title={c.item}>
            {c.item}
          </span>
        ),
      },
      { key: 'customer', label: 'Customer', value: (c) => c.customer, cell: (c) => c.customer || '—' },
      { key: 'due', label: 'Due', value: (c) => dayLabel(c.dueDate), sortValue: (c) => c.dueDate, cell: (c) => dayLabel(c.dueDate), className: 'whitespace-nowrap' },
      {
        key: 'before',
        label: 'Before',
        value: (c) => wallLabel(c.baseEnd),
        sortValue: (c) => c.baseEnd,
        noValues: true,
        cell: (c) => (
          <>
            {wallLabel(c.baseEnd)}
            {c.baseLateDays > 0 && (
              <Badge tone="red" className="ml-1">
                {c.baseLateDays} d late
              </Badge>
            )}
          </>
        ),
        className: 'whitespace-nowrap',
      },
      {
        key: 'after',
        label: 'With the order',
        value: (c) => wallLabel(c.scenarioEnd),
        sortValue: (c) => c.scenarioEnd,
        noValues: true,
        cell: (c) => (
          <>
            {wallLabel(c.scenarioEnd)}
            {c.scenarioLateDays > 0 && (
              <Badge tone="red" className="ml-1">
                {c.scenarioLateDays} d late
              </Badge>
            )}
          </>
        ),
        className: 'whitespace-nowrap',
      },
      {
        key: 'moves',
        label: 'Moves',
        numeric: true,
        right: true,
        value: (c) => (c.shiftDays === null ? '' : String(c.shiftDays)),
        sortValue: (c) => c.shiftDays,
        cell: (c) => (
          <span className={cn('font-semibold', (c.shiftDays ?? 0) > 0 ? 'text-danger-700 dark:text-danger-400' : 'text-success-700 dark:text-success-400')}>
            {c.shiftDays === null ? '—' : `${c.shiftDays > 0 ? '+' : ''}${c.shiftDays} d`}
          </span>
        ),
      },
    ],
    [],
  )
  const view = useGrid(rows, columns)
  return (
    <DataGrid
      view={view}
      columns={columns}
      rowKey={(c) => c.lineKey}
      total={rows.length}
      noun="lines of other orders"
      caption="The lines of other orders it moves"
      empty={<EmptyState title="No other order moves" hint="The order fits without moving anything by a day." />}
    />
  )
}

function Headline({ label, outcome, dueDate, tone }: { label: string; outcome: QuoteOutcome; dueDate: string | null; tone?: 'brand' }) {
  const late = outcome.lateDays > 0
  return (
    <div
      className={cn(
        'rounded-xl p-3 ring-1 ring-inset',
        tone === 'brand' ? 'bg-brand-50 ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'bg-slate-50 ring-slate-200 dark:bg-slate-800/50 dark:ring-slate-700',
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-xl font-bold tabular-nums',
          outcome.completes === null ? 'text-danger-700 dark:text-danger-400' : late ? 'text-warning-800 dark:text-warning-400' : 'text-success-700 dark:text-success-400',
        )}
      >
        {outcome.completes === null ? 'Cannot be placed' : `Done ${wallLabel(outcome.completes)}`}
      </p>
      <p className="text-13 text-muted">
        {outcome.completes === null
          ? 'A step has no working time in the horizon.'
          : dueDate
            ? late
              ? `${outcome.lateDays} day${outcome.lateDays === 1 ? '' : 's'} after the day asked (${dayLabel(dueDate)}).`
              : `In time for ${dayLabel(dueDate)}.`
            : 'No day asked.'}{' '}
        {outcome.newlyLate > 0 ? <span className="font-semibold text-danger-700 dark:text-danger-400">{outcome.newlyLate} lines of other orders turn late</span> : 'No other order turns late'}
        {outcome.recovered > 0 ? `, ${outcome.recovered} recover` : ''}
        {outcome.lateWeightKgDelta !== 0 ? ` (${outcome.lateWeightKgDelta > 0 ? '+' : ''}${tonnes(outcome.lateWeightKgDelta)} late weight)` : ''}.
      </p>
    </div>
  )
}

function Advice({ a, onKeep, keeping }: { a: AdviseResponse; onKeep: (o: AdviceOption) => void; keeping: boolean }) {
  const { can } = useAuth()
  const rows = useMemo(() => [a.asIs, ...a.options], [a])
  const columns = useMemo<GridColumn<AdviceOption>[]>(
    () => [
      {
        key: 'name',
        label: 'Option',
        value: (o) => o.name,
        noValues: true,
        cell: (o) => (
          <>
            <span className="flex items-center gap-1.5 font-semibold">
              {o.name}
              {o.id === a.bestId && (
                <Badge tone="green" icon={<Check className="h-3 w-3" />}>
                  Best
                </Badge>
              )}
            </span>
            <span className="block max-w-[380px] text-xs text-muted" title={o.detail}>
              {o.detail}
            </span>
          </>
        ),
      },
      {
        key: 'completes',
        label: 'Done',
        value: (o) => wallLabel(o.completes),
        sortValue: (o) => o.completes,
        noValues: true,
        cell: (o) => (o.completes === null ? <span className="text-danger-700 dark:text-danger-400">Cannot be placed</span> : wallLabel(o.completes)),
        className: 'whitespace-nowrap',
      },
      {
        key: 'meets',
        label: 'Meets the day',
        value: (o) => (o.meetsDue ? 'Yes' : 'No'),
        cell: (o) => (o.meetsDue ? <Badge tone="green">Yes</Badge> : <Badge tone="red">{o.lateDays >= 999 ? 'No' : `No, ${o.lateDays} d late`}</Badge>),
      },
      {
        key: 'newlyLate',
        label: 'Others turn late',
        numeric: true,
        right: true,
        value: (o) => String(o.newlyLate),
        sortValue: (o) => o.newlyLate,
        cell: (o) => (o.newlyLate > 0 ? <span className="font-semibold text-danger-700 dark:text-danger-400">{o.newlyLate}</span> : '0'),
      },
      {
        key: 'recovered',
        label: 'Recover',
        numeric: true,
        right: true,
        value: (o) => String(o.recovered),
        sortValue: (o) => o.recovered,
        cell: (o) => (o.recovered > 0 ? <span className="font-semibold text-success-700 dark:text-success-400">{o.recovered}</span> : '0'),
      },
      {
        key: 'tonneDays',
        label: 'Tonne-days added',
        numeric: true,
        right: true,
        value: (o) => String(o.lateTonneDaysDelta),
        sortValue: (o) => o.lateTonneDaysDelta,
        cell: (o) => o.lateTonneDaysDelta.toLocaleString(),
      },
      {
        key: 'cost',
        label: 'Cost',
        numeric: true,
        right: true,
        value: (o) => (o.cost === null ? '' : String(o.cost)),
        sortValue: (o) => o.cost,
        cell: (o) => (
          <span title={o.costLines.join('\n')}>
            {o.cost === null ? <span className="text-muted">—</span> : o.cost.toLocaleString()}
            {o.costLines.length > 0 && (
              <span className="block text-xs text-muted">
                {o.costLines[0]}
                {o.costLines.length > 1 ? ` (+${o.costLines.length - 1})` : ''}
              </span>
            )}
          </span>
        ),
      },
      {
        key: 'keep',
        label: '',
        plain: true,
        value: () => '',
        cell: (o) =>
          o.events.length > 0 && can('edit-planning') ? (
            <Button className="min-h-[36px] px-2.5" disabled={keeping} onClick={() => onKeep(o)} data-tip="Keep it as a scenario in the Simulator">
              <Save className="h-4 w-4" /> Keep
            </Button>
          ) : null,
      },
    ],
    [a.bestId, can, onKeep, keeping],
  )
  const view = useGrid(rows, columns)
  return (
    <DataGrid
      view={view}
      columns={columns}
      rowKey={(o) => o.id}
      total={rows.length}
      noun="options"
      caption="The options to meet the day"
      empty={<EmptyState title="No option" />}
      footer={
        <>
          <span>
            Order {a.target.orderNumber}, {a.target.lines} lines, by {dayLabel(a.dueDate, true)}, on {a.baseName}.
          </span>
          {a.warnings.map((w) => (
            <span key={w} className="text-warning-800 dark:text-warning-400">
              {w}
            </span>
          ))}
        </>
      }
    />
  )
}

export function QuoteSection() {
  const { can, factoryTimeZone } = useAuth()
  const today = calendarDay(new Date(), factoryTimeZone)
  const navigate = useNavigate()
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [customer, setCustomer] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([blankItem()])
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'asIs' | 'rushed' | 'impact' | 'advice'>('asIs')
  const routes = useRoutes(search.trim(), '')
  const plans = usePlans()
  const published = plans.data?.plans.find((p) => p.status === 'published') ?? null
  const quote = useQuote()
  const advise = useAdvise()
  const create = useCreatePlan()
  const q = quote.data
  const a = advise.data

  // The routes seen so far, whatever was searched: each item's line reads from them.
  const [known, setKnown] = useState<Map<string, ItemRoute>>(() => new Map())
  useEffect(() => {
    if (!routes.data) return
    setKnown((m) => {
      const next = new Map(m)
      for (const r of routes.data!.routes) next.set(r.itemCode, r)
      return next
    })
  }, [routes.data])
  const offered = routes.data?.routes ?? []
  const setItem = (key: number, patch: Partial<ItemDraft>) => setItems((l) => l.map((i) => (i.key === key ? { ...i, ...patch } : i)))
  const request = (): QuoteRequest | null => {
    const its = items.filter((i) => i.itemCode.trim() && Number(i.qty) > 0).map((i) => ({ itemCode: i.itemCode.trim(), qty: Number(i.qty) }))
    if (its.length === 0) return null
    return { customer: customer.trim() || undefined, dueDate: dueDate || null, items: its, basePlan: published ? 'published' : 'auto' }
  }
  const ask = () => {
    const req = request()
    if (!req) return
    advise.reset()
    setView('asIs')
    quote.mutate(req)
  }
  const askAdvice = () => {
    if (!dueDate) return
    const body =
      mode === 'existing'
        ? { orderNumber: orderNumber.trim(), dueDate, basePlan: published ? 'published' : 'auto' }
        : (() => {
            const req = request()
            return req ? { newOrder: { customer: req.customer, items: req.items, orderNumber: req.orderNumber }, dueDate, basePlan: req.basePlan } : null
          })()
    if (!body) return
    setView('advice')
    advise.mutate(body)
  }
  const keep = async (name: string, events: PlanEvent[]) => {
    const made = await create.mutateAsync({ kind: 'scenario', name: name.slice(0, 120), fromId: published?.id, events })
    navigate(`/planning/simulator?plan=${encodeURIComponent(made.plan.id)}`)
  }
  const canAsk = mode === 'new' ? request() !== null : orderNumber.trim() !== ''
  const busy = quote.isPending || advise.isPending

  return (
    <PartFrame
      toolbar={
        <>
          <Segmented
            label="The order"
            value={mode}
            onChange={(m) => {
              setMode(m)
              quote.reset()
              advise.reset()
            }}
            options={[
              { value: 'new', label: 'A new order' },
              { value: 'existing', label: 'An order on the sheet' },
            ]}
          />
          {mode === 'new' ? (
            <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Customer (optional)" aria-label="Customer" className="h-10 w-48 py-0 text-sm touch:h-11" />
          ) : (
            <Input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="Order number" aria-label="Order number" className="h-10 w-40 py-0 text-sm touch:h-11" />
          )}
          <Input type="date" value={dueDate} min={today} onChange={(e) => setDueDate(e.target.value)} aria-label="The day wanted" className="h-10 w-auto py-0 text-sm touch:h-11" />
          <span className="text-13 text-muted">{dueDate ? 'The day the customer wants it.' : 'The day wanted (optional for a quote, needed for advice).'}</span>
          <span className="flex-1" />
          {mode === 'new' && (
            <Button variant="primary" className="min-h-[40px]" disabled={!canAsk || busy} onClick={ask}>
              <CalendarCheck className="h-4 w-4" /> When could it be done?
            </Button>
          )}
          <Button
            className="min-h-[40px]"
            disabled={!canAsk || !dueDate || busy}
            onClick={askAdvice}
            data-tip={dueDate ? 'What would have it done by that day, and what each option costs' : 'Choose the day first'}
          >
            <Lightbulb className="h-4 w-4" /> How to have it done by then
          </Button>
        </>
      }
    >
      <div className="grid min-h-0 flex-1 overflow-auto lg:grid-cols-[340px,1fr] lg:overflow-visible">
        {/* The items */}
        <div className="flex flex-col border-b border-slate-200 lg:min-h-0 lg:border-b-0 lg:border-r dark:border-slate-700">
          {mode === 'new' ? (
            <>
              <div className="shrink-0 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
                <h2 className="text-sm font-bold">The items</h2>
                <p className="text-xs text-muted">Each is planned through its learnt route (Routes & paces) at the machines’ learnt pace. An item the record does not know cannot be quoted yet.</p>
              </div>
              <Scroller className="p-3">
                <datalist id="planning-quote-items">
                  {offered.map((r) => (
                    <option key={r.itemCode} value={r.itemCode.toUpperCase()}>
                      {r.item}
                    </option>
                  ))}
                </datalist>
                <ul className="space-y-2">
                  {items.map((it) => {
                    const route = known.get(it.itemCode.trim().toLowerCase())
                    return (
                      <li key={it.key} className="rounded-xl p-2 ring-1 ring-inset ring-slate-200 dark:ring-slate-700">
                        <div className="flex items-center gap-2">
                          <Input
                            value={it.itemCode}
                            onChange={(e) => {
                              setItem(it.key, { itemCode: e.target.value })
                              setSearch(e.target.value)
                            }}
                            list="planning-quote-items"
                            placeholder="Item code"
                            aria-label="Item code"
                            className="h-10 min-w-0 flex-1 py-0 text-sm touch:h-11"
                          />
                          <Input
                            type="number"
                            min={1}
                            value={it.qty}
                            onChange={(e) => setItem(it.key, { qty: e.target.value })}
                            placeholder="Pieces"
                            aria-label="Pieces"
                            className="h-10 w-24 py-0 text-sm touch:h-11"
                          />
                          <button
                            type="button"
                            onClick={() => setItems((l) => (l.length > 1 ? l.filter((x) => x.key !== it.key) : l))}
                            aria-label="Remove the item"
                            className="icon-btn h-9 w-9 shrink-0"
                            disabled={items.length === 1}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <p className="mt-1 truncate pl-1 text-xs text-muted">
                          {route ? (
                            <>
                              {route.item} · {route.steps.map((s) => PROCESS_NAMES[s.process]).join(' → ')}
                              {route.kgPerPiece !== null ? ` · ${route.kgPerPiece} kg a piece` : ''}
                            </>
                          ) : it.itemCode.trim() ? (
                            <span className="text-warning-800 dark:text-warning-400">No learnt route for this code: it cannot be quoted until the record has it.</span>
                          ) : (
                            'Type a code; the known ones are offered.'
                          )}
                        </p>
                      </li>
                    )
                  })}
                </ul>
                <Button className="mt-2 min-h-[36px] px-2.5" onClick={() => setItems((l) => [...l, blankItem()])}>
                  <Plus className="h-4 w-4" /> Another item
                </Button>
              </Scroller>
            </>
          ) : (
            <div className="p-3 text-13 text-muted">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">An order on the sheet</h2>
              <p className="mt-1">
                Name its order number and the day it must be done by, then ask how to have it done by then: the advice rushes it, works the Fridays, adds hours a day on its machines, moves its steps
                to freer machines, and says which options meet the day and what each costs.
              </p>
              <p className="mt-2">
                Prices for the options are set under{' '}
                <Link to="/planning/settings" className="font-semibold text-brand-700 underline-offset-4 hover:underline dark:text-brand-300">
                  Settings
                </Link>
                .
              </p>
            </div>
          )}
          <PartFooter>
            <span>Laid on {published ? `the published plan (${published.name})` : 'the automatic plan (no plan is published)'}. Nothing is kept until you keep it.</span>
          </PartFooter>
        </div>

        {/* The answer */}
        <div className="flex min-h-[24rem] flex-col lg:min-h-0">
          {busy ? (
            <Loading what={advise.isPending ? 'Trying the options' : 'Laying the order on the plan'} />
          ) : quote.error || advise.error ? (
            <div className="p-3">
              <ErrorNote error={quote.error ?? advise.error} />
            </div>
          ) : view === 'advice' && a ? (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
                <h2 className="text-sm font-bold">
                  How to have {a.target.orderNumber} done by {dayLabel(a.dueDate)}
                </h2>
                <span className="flex-1" />
                {q && (
                  <Button className="min-h-[36px] px-2.5" onClick={() => setView('asIs')}>
                    <X className="h-4 w-4" /> Back to the quote
                  </Button>
                )}
              </div>
              <Advice a={a} keeping={create.isPending} onKeep={(o) => void keep(`${a.target.orderNumber} by ${a.dueDate}: ${o.name}`, o.events)} />
              {create.error && (
                <div className="p-3">
                  <ErrorNote error={create.error} />
                </div>
              )}
            </>
          ) : q ? (
            <>
              <div className="shrink-0 space-y-2 border-b border-slate-200 p-3 dark:border-slate-700">
                <div className="grid gap-2 lg:grid-cols-2">
                  <Headline label="In its turn" outcome={q.asIs} dueDate={q.dueDate} tone="brand" />
                  <Headline label="Rushed ahead of everything" outcome={q.rushed} dueDate={q.dueDate} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    label="Show"
                    value={view === 'advice' ? 'asIs' : view}
                    onChange={(v) => setView(v)}
                    options={[
                      { value: 'asIs', label: 'Its steps, in its turn' },
                      { value: 'rushed', label: 'Its steps, rushed' },
                      { value: 'impact', label: `Other orders it moves (${q.asIs.impacted.length})` },
                    ]}
                  />
                  <span className="flex-1" />
                  {can('edit-planning') && (
                    <Button
                      className="min-h-[36px] px-2.5"
                      disabled={create.isPending}
                      onClick={() => void keep(`${q.orderNumber}${customer ? ` for ${customer}` : ''}: ${items.map((i) => `${i.qty} × ${i.itemCode}`).join(', ')}`, q.events)}
                      data-tip="Keep it as a scenario in the Simulator, to work on or publish"
                    >
                      <Save className="h-4 w-4" /> Keep as a scenario
                    </Button>
                  )}
                </div>
                {q.unknownItems.length > 0 && <p className="text-13 text-warning-800 dark:text-warning-400">Not planned, no learnt route: {q.unknownItems.join(', ')}.</p>}
                {q.warnings.map((w) => (
                  <p key={w} className="text-13 text-warning-800 dark:text-warning-400">
                    {w}
                  </p>
                ))}
                {create.error && <ErrorNote error={create.error} />}
              </div>
              {view === 'impact' ? (
                <Impacted rows={q.asIs.impacted} />
              ) : (
                <QuoteLines outcome={view === 'rushed' ? q.rushed : q.asIs} caption={view === 'rushed' ? 'The order’s steps, rushed' : 'The order’s steps, in its turn'} />
              )}
            </>
          ) : (
            <div className="grid flex-1 place-items-center p-6">
              <EmptyState
                icon={<CalendarCheck className="h-10 w-10" />}
                title={mode === 'new' ? 'When could it be done?' : 'How to have it done by a day'}
                hint={
                  mode === 'new'
                    ? 'Name the items and their quantities on the left, then ask: the plan says the day it would be done, in its turn and rushed, and what it does to the other orders.'
                    : 'Name the order and the day in the toolbar, then ask for the advice.'
                }
              />
            </div>
          )}
          {q && view !== 'advice' && !busy && (
            <PartFooter>
              <span>
                {q.orderNumber} on {q.baseName}, worked out from {wallLabel(q.now)}. A promise is as good as the learnt routes and paces: a step marked assumed had nothing to go by.
              </span>
            </PartFooter>
          )}
        </div>
      </div>
    </PartFrame>
  )
}
