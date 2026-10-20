// ============================================================================
// §25 — Simulator: what if. A scenario is the plan it was made from (the
// automatic plan unless another is chosen) with changes — a machine down, a
// rush order, a Friday worked, a shift added, a line moved, material late —
// worked out again at once and set beside it line by line: which lines turn
// late or recover, how far each moves, which customers it hits. A planner
// may publish a scenario as the plan; the AI assistant can try scenarios and
// keep them here for a planner to review (marked as the assistant's).
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Archive, Bot, CalendarClock, FlaskConical, Plus, Send, Sparkles, Trash2, X } from 'lucide-react'
import { AUTO_PLAN_ID, type ComparisonResponse, type PlanDetail, type PlanEventType, type PlanHeader, type PlanSettings } from '@qc/shared/planning'
import { Badge, Button, EmptyState, Field, Input, Select } from '@/components/ui'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { cn, formatDateTime } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'
import { useCompare, useCreatePlan, usePlan, usePlanAction, usePlans, useUpdatePlan } from '@/services/planning'
import { ErrorNote, Figure, Loading, OBJECTIVE_NAME, OptimiserNote, PlanPicker, SectionCard } from './common'
import { EventForm, describeEvent } from './events'
import { dayLabel, pctLabel, tonnes, wallLabel } from './format'

/** Where a planner usually starts: the question, and the change it opens with. */
const STARTS: { name: string; type: PlanEventType; hint: string }[] = [
  { name: 'A machine breaks down', type: 'machine-down', hint: 'Which lines slip, and by how much' },
  { name: 'A rush order comes in', type: 'add-order', hint: 'What it pushes back to fit it' },
  { name: 'We work a Friday', type: 'working-day', hint: 'How many late lines it saves' },
  { name: 'A shift is added', type: 'capacity', hint: 'What more hours a day give' },
  { name: 'A customer goes first', type: 'priority', hint: 'Who pays for it' },
  { name: 'Material comes late', type: 'material', hint: 'Which machines sit idle' },
]

function Delta({ base, now, better }: { base: number | null; now: number | null; better: 'lower' | 'higher' }) {
  if (base === null || now === null) return null
  const d = Math.round((now - base) * 10) / 10
  if (d === 0) return <span className="text-muted">no change</span>
  const good = better === 'lower' ? d < 0 : d > 0
  return <span className={cn('font-semibold', good ? 'text-success-700 dark:text-success-400' : 'text-danger-700 dark:text-danger-400')}>{`${d > 0 ? '+' : ''}${d.toLocaleString()}`}</span>
}

function Comparison({ cmp, now }: { cmp: ComparisonResponse; now: number }) {
  const a = cmp.base
  const b = cmp.scenario
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Figure label="Late lines" value={b.late.toLocaleString()} tone={b.late > a.late ? 'danger' : b.late < a.late ? 'success' : undefined} sub={<><Delta base={a.late} now={b.late} better="lower" /> against {a.late}</>} />
        <Figure label="On time" value={pctLabel(b.onTimePct)} sub={<><Delta base={a.onTimePct} now={b.onTimePct} better="higher" /> points</>} />
        <Figure label="Late weight" value={tonnes(b.lateWeightKg)} sub={<><Delta base={Math.round(a.lateWeightKg / 100) / 10} now={Math.round(b.lateWeightKg / 100) / 10} better="lower" /> t</>} />
        <Figure label="Last line done" value={b.lastFinish ? wallLabel(b.lastFinish).slice(0, 10) : '—'} sub={a.lastFinish && b.lastFinish ? <><Delta base={Math.round(a.lastFinish / 1440)} now={Math.round(b.lastFinish / 1440)} better="lower" /> days</> : undefined} />
      </div>
      <p className="text-sm">
        Against <span className="font-semibold">{cmp.baseName}</span>: <span className="font-semibold text-danger-700 dark:text-danger-400">{cmp.newlyLate} turn late</span>,{' '}
        <span className="font-semibold text-success-700 dark:text-success-400">{cmp.recovered} recover</span>, {cmp.later} finish a day or more later, {cmp.sooner} sooner.
      </p>
      {cmp.changes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <caption className="sr-only">The lines that move most</caption>
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th scope="col" className="py-2 pr-3 font-semibold">Line</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Customer</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Due</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Before</th>
                <th scope="col" className="py-2 pr-3 font-semibold">With the changes</th>
                <th scope="col" className="py-2 font-semibold">Moves</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {cmp.changes.slice(0, 60).map((c) => (
                <tr key={`${c.lineKey}|${c.only ?? ''}`}>
                  <td className="py-2 pr-3">
                    <span className="block font-semibold">{c.orderNumber}</span>
                    <span className="block max-w-[240px] truncate text-xs text-muted">
                      {c.item} · {c.lineKey}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{c.customer || '—'}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{c.dueDate ? dayLabel(c.dueDate) : '—'}</td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    {c.only === 'scenario' ? 'Not in it' : wallLabel(c.baseEnd)}
                    {c.baseLateDays > 0 && <Badge tone="red" className="ml-1">{c.baseLateDays} d late</Badge>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    {c.only === 'base' ? 'Left out' : wallLabel(c.scenarioEnd)}
                    {c.scenarioLateDays > 0 && <Badge tone="red" className="ml-1">{c.scenarioLateDays} d late</Badge>}
                  </td>
                  <td className={cn('whitespace-nowrap py-2 font-semibold tabular-nums', (c.shiftDays ?? 0) > 0 ? 'text-danger-700 dark:text-danger-400' : (c.shiftDays ?? 0) < 0 ? 'text-success-700 dark:text-success-400' : 'text-muted')}>
                    {c.shiftDays === null ? '—' : `${c.shiftDays > 0 ? '+' : ''}${c.shiftDays} d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cmp.changes.length > 60 && <p className="mt-2 text-xs text-muted">The 60 that move most of {cmp.changes.length} shown.</p>}
        </div>
      )}
      <p className="text-xs text-muted">Worked out from {wallLabel(now)}.</p>
    </div>
  )
}

const SEQUENCE: Record<PlanSettings['sequenceRule'], string> = { erp: 'ERP planned start', due: 'Due day', fifo: 'Order date' }

function ScenarioSettings({ detail, onSave, pending }: { detail: PlanDetail; onSave: (s: Partial<PlanSettings>) => void; pending: boolean }) {
  const s = detail.plan.settings
  const e = detail.effectiveSettings
  const set = (patch: Partial<PlanSettings>) => onSave({ ...s, ...patch })
  const disabled = !detail.plan.editable || pending
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Lines run in the order of">
        <Select disabled={disabled} value={e.sequenceRule} onChange={(x) => set({ sequenceRule: x.target.value as PlanSettings['sequenceRule'] })} className="min-h-[44px]">
          {Object.entries(SEQUENCE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Hours come first from">
        <Select disabled={disabled} value={e.timeSource} onChange={(x) => set({ timeSource: x.target.value as PlanSettings['timeSource'] })} className="min-h-[44px]">
          <option value="erp-first">The ERP’s duration</option>
          <option value="actual-first">The machine’s record</option>
        </Select>
      </Field>
      <Field label="Next stage may overlap" hint="0 = waits for the earlier stage to finish.">
        <Select disabled={disabled} value={String(e.overlapPct)} onChange={(x) => set({ overlapPct: Number(x.target.value) })} className="min-h-[44px]">
          {[0, 25, 50, 75, 100].map((p) => (
            <option key={p} value={p}>
              {p}%
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Lines the ERP holds">
        <Select disabled={disabled} value={e.includeHold ? 'yes' : 'no'} onChange={(x) => set({ includeHold: x.target.value === 'yes' })} className="min-h-[44px]">
          <option value="no">Left out</option>
          <option value="yes">Planned too</option>
        </Select>
      </Field>
      <Field label="Optimiser">
        <Select disabled={disabled} value={e.optimise} onChange={(x) => set({ optimise: x.target.value as PlanSettings['optimise'] })} className="min-h-[44px]">
          <option value="off">Off: the priority order</option>
          <option value="light">Light</option>
          <option value="full">Full</option>
        </Select>
      </Field>
      <Field label="It makes smaller">
        <Select disabled={disabled} value={e.objective} onChange={(x) => set({ objective: x.target.value as PlanSettings['objective'] })} className="min-h-[44px]">
          {(Object.keys(OBJECTIVE_NAME) as PlanSettings['objective'][]).map((k) => (
            <option key={k} value={k}>
              {OBJECTIVE_NAME[k]}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

function NewScenario({ onMade, start }: { onMade: (id: string, type?: PlanEventType) => void; start?: (typeof STARTS)[number] | null }) {
  const create = useCreatePlan()
  const [name, setName] = useState(start?.name ?? '')
  const [from, setFrom] = useState(AUTO_PLAN_ID)
  useEffect(() => setName(start?.name ?? ''), [start])
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        const d = await create.mutateAsync({ kind: 'scenario', name: name.trim() || 'What if', fromId: from })
        onMade(d.plan.id, start?.type)
      }}
    >
      <Field label="Name">
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="What if the press stops on Sunday" className="min-h-[44px]" required />
      </Field>
      <Field label="Start from">
        <PlanPicker value={from} onChange={setFrom} className="w-full" label="Start from" />
      </Field>
      {create.error && <ErrorNote error={create.error} />}
      <Button type="submit" variant="primary" className="min-h-[44px] w-full" disabled={create.isPending}>
        <Plus className="h-4 w-4" /> Make the scenario
      </Button>
    </form>
  )
}

function ScenarioList({ plans, selected, onSelect }: { plans: PlanHeader[]; selected: string | null; onSelect: (id: string) => void }) {
  if (plans.length === 0) return <p className="text-sm text-muted">No scenario yet.</p>
  return (
    <ul className="space-y-1.5">
      {plans.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onSelect(p.id)}
            aria-current={selected === p.id ? 'true' : undefined}
            className={cn(
              'w-full rounded-xl px-3 py-2.5 text-left ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
              selected === p.id ? 'bg-brand-50 ring-brand-300 dark:bg-brand-500/15 dark:ring-brand-500/40' : 'bg-white ring-slate-200 hover:ring-brand-300 dark:bg-slate-900 dark:ring-slate-700',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
              {p.createdVia === 'assistant' && (
                <Badge tone="violet" icon={<Bot className="h-3 w-3" />} tip="Kept by the AI assistant for a planner to review">
                  Assistant
                </Badge>
              )}
              {p.status !== 'draft' && <Badge tone={p.status === 'published' ? 'green' : 'neutral'}>{p.status}</Badge>}
            </span>
            <span className="mt-0.5 block text-xs text-muted">
              {p.eventCount} change{p.eventCount === 1 ? '' : 's'} · {p.summary ? `${p.summary.late} late` : 'not worked out'} · {p.createdByName}, {formatDateTime(p.updatedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ScenarioView({ id, addType, onGone }: { id: string; addType: PlanEventType | null; onGone: () => void }) {
  const { data: detail, error, isLoading, refetch } = usePlan(id)
  const { data: cmp, error: cmpError } = useCompare(id)
  const update = useUpdatePlan(id)
  const action = usePlanAction(id)
  const { can } = useAuth()
  const ai = useAi()
  const machines = useMemo(() => new Map((detail?.machines ?? []).map((m) => [m.key, m])), [detail])
  const [adding, setAdding] = useState(addType !== null)
  useEffect(() => setAdding(addType !== null), [addType, id])
  if (isLoading) return <Loading />
  if (error || !detail) return <ErrorNote error={error} retry={() => void refetch()} />
  const p = detail.plan
  const editable = p.editable
  const removeEvent = (eid: string) => update.mutate({ version: p.version, events: p.events.filter((e) => e.id !== eid) })
  const ask = () =>
    ai.compose(
      `Planning: look at the scenario "${p.name}" (plan_id ${p.id}) against the plan it was made from. Explain what its changes do, which lines and customers they hit, and try one or two better variants with planning_simulate.`,
    )
  return (
    <div className="space-y-4">
      <SectionCard
        title={p.name}
        hint={
          <>
            {p.kind === 'scenario' ? 'Scenario' : 'Plan'} made {formatDateTime(p.createdAt)} by {p.createdByName}
            {p.createdVia === 'assistant' ? ' through the AI assistant' : ''}. {p.status === 'draft' ? 'A draft: change it freely, the factory’s plan stays as it is.' : `It is ${p.status}.`}
            {p.description && <span className="mt-1 block whitespace-pre-line text-slate-700 dark:text-slate-300">{p.description}</span>}
          </>
        }
        actions={
          <>
            {ai.enabled && (
              <Button className="min-h-[44px]" onClick={ask} data-tip="Opens the assistant with this scenario: it explains it and tries variants">
                <Sparkles className="h-4 w-4" /> Ask the assistant
              </Button>
            )}
            <Link to={`/planning/schedule?plan=${encodeURIComponent(p.id)}`} className="btn-secondary min-h-[44px]">
              <CalendarClock className="h-4 w-4" /> Schedule
            </Link>
            {can('publish-plan') && p.status === 'draft' && (
              <Button
                variant="primary"
                className="min-h-[44px]"
                disabled={action.isPending}
                onClick={() => {
                  if (window.confirm(`Publish “${p.name}” as the factory’s plan? The plan published now is kept as superseded.`)) action.mutate({ action: 'publish', version: p.version })
                }}
              >
                <Send className="h-4 w-4" /> Publish
              </Button>
            )}
            {can('edit-planning') && p.status === 'draft' && (
              <Button className="min-h-[44px]" disabled={action.isPending} onClick={() => action.mutate({ action: 'archive', version: p.version })}>
                <Archive className="h-4 w-4" /> Archive
              </Button>
            )}
            {can('edit-planning') && (p.status === 'draft' || p.status === 'archived') && (
              <Button
                variant="ghost"
                className="min-h-[44px] text-danger-700 dark:text-danger-400"
                disabled={action.isPending}
                onClick={async () => {
                  if (!window.confirm(`Delete “${p.name}”? It goes from the lists; the audit log keeps that it was made.`)) return
                  await action.mutateAsync({ action: 'delete', version: p.version })
                  onGone()
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </>
        }
      >
        {action.error && <ErrorNote error={action.error} />}
        <h3 className="mb-2 text-sm font-bold">Changes</h3>
        {p.events.length === 0 ? (
          <p className="text-sm text-muted">No change yet: as it stands, it is the plan it was made from.</p>
        ) : (
          <ol className="space-y-1.5">
            {p.events.map((e) => (
              <li key={e.id} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm ring-1 ring-inset ring-slate-200 dark:bg-slate-800/50 dark:ring-slate-700">
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{describeEvent(e, machines)}</span>
                  {e.note && <span className="block text-xs text-muted">{e.note}</span>}
                </span>
                {editable && (
                  <button type="button" onClick={() => removeEvent(e.id)} disabled={update.isPending} aria-label={`Remove: ${describeEvent(e, machines)}`} className="icon-btn h-9 w-9 shrink-0">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        <div className="mt-3">
          <OptimiserNote o={detail.optimisation} late={detail.plan.summary?.late ?? 0} />
        </div>
        {detail.warnings.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-13 text-warning-800 dark:text-warning-400">
            {detail.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {editable && (
          <div className="mt-4">
            {adding ? (
              <div className="rounded-xl p-3 ring-1 ring-inset ring-brand-200 dark:ring-brand-500/30">
                <EventForm
                  key={`${id}:${addType ?? ''}`}
                  detail={detail}
                  initial={{ type: addType ?? undefined }}
                  pending={update.isPending}
                  onAdd={async (e) => {
                    await update.mutateAsync({ version: p.version, events: [...p.events, e as never] })
                    setAdding(false)
                  }}
                />
              </div>
            ) : (
              <Button className="min-h-[44px]" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" /> Add a change
              </Button>
            )}
            {update.error && <ErrorNote error={update.error} />}
          </div>
        )}
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-bold">How this scenario plans</summary>
          <div className="mt-3">
            <ScenarioSettings detail={detail} pending={update.isPending} onSave={(settings) => update.mutate({ version: p.version, settings })} />
          </div>
        </details>
      </SectionCard>
      <SectionCard title="What it changes" hint="This scenario against the plan it was made from, line by line, both worked out from the data as it is now.">
        {cmpError ? <ErrorNote error={cmpError} /> : cmp ? <Comparison cmp={cmp} now={detail.now} /> : <Loading what="Comparing" />}
      </SectionCard>
    </div>
  )
}

export function SimulatorSection() {
  const [params, setParams] = useSearchParams()
  const { data, error, isLoading, refetch } = usePlans()
  const { can } = useAuth()
  const selected = params.get('plan')
  const addType = (params.get('add') as PlanEventType | null) ?? null
  const [start, setStart] = useState<(typeof STARTS)[number] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const scenarios = (data?.plans ?? []).filter((p) => p.kind === 'scenario' && (showArchived || p.status !== 'archived'))
  const select = (id: string | null, type?: PlanEventType) => {
    const next = new URLSearchParams(params)
    if (id) next.set('plan', id)
    else next.delete('plan')
    if (type) next.set('add', type)
    else next.delete('add')
    setParams(next, { replace: true })
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
      <div className="space-y-4">
        {can('edit-planning') && (
          <SectionCard title="New scenario" hint="Start from the automatic plan, or from any plan.">
            <NewScenario start={start} onMade={(id, type) => select(id, type)} />
          </SectionCard>
        )}
        <SectionCard
          title="Scenarios"
          actions={
            <label className="flex items-center gap-2 text-13 text-muted">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4" /> Archived too
            </label>
          }
        >
          {isLoading ? <Loading what="Reading" /> : error ? <ErrorNote error={error} retry={() => void refetch()} /> : <ScenarioList plans={scenarios} selected={selected} onSelect={(id) => select(id)} />}
        </SectionCard>
      </div>
      <div>
        {selected ? (
          <ScenarioView key={selected} id={selected} addType={addType} onGone={() => select(null)} />
        ) : (
          <SectionCard title="What if…" hint="Choose a question to start a scenario with it, or open one on the left. Nothing here changes the factory’s plan until someone publishes it.">
            {can('edit-planning') ? (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {STARTS.map((s) => (
                  <li key={s.type}>
                    <button
                      type="button"
                      onClick={() => setStart(s)}
                      className={cn(
                        'h-full w-full rounded-xl p-4 text-left ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                        start?.type === s.type ? 'bg-brand-50 ring-brand-300 dark:bg-brand-500/15 dark:ring-brand-500/40' : 'bg-white ring-slate-200 hover:ring-brand-300 dark:bg-slate-900 dark:ring-slate-700',
                      )}
                    >
                      <span className="block font-semibold">{s.name}</span>
                      <span className="mt-0.5 block text-13 text-muted">{s.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<FlaskConical className="h-10 w-10" />} title="Open a scenario on the left" hint="Making scenarios needs the permission “Make plans and scenarios”." />
            )}
            {start && <p className="mt-3 text-13 text-muted">Name it on the left and press Make the scenario: the change opens ready to fill in.</p>}
          </SectionCard>
        )}
      </div>
    </div>
  )
}
