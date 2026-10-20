// ============================================================================
// §25 — Plans: every plan and scenario with its totals, who made it (a person
// or the AI assistant), and what can be done with it: make a plan from the
// automatic one or from another, publish it as the factory's plan, archive
// it, delete a draft. The published plan is the one the floor follows and
// plan against actual measures; publishing another keeps it as superseded.
// ============================================================================

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Archive, Bot, CalendarClock, FlaskConical, Plus, Send, Trash2 } from 'lucide-react'
import { AUTO_PLAN_ID, type PlanHeader } from '@qc/shared/planning'
import { Badge, Button, Field, Input } from '@/components/ui'
import { formatDateTime } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'
import { useCreatePlan, usePlanAction, usePlans } from '@/services/planning'
import { ErrorNote, Loading, PlanPicker, SectionCard } from './common'
import { pctLabel, tonnes } from './format'

const STATUS_TONE = { draft: 'blue', published: 'green', superseded: 'neutral', archived: 'neutral' } as const

function PlanRow({ p }: { p: PlanHeader }) {
  const { can } = useAuth()
  const action = usePlanAction(p.id)
  const navigate = useNavigate()
  const isAuto = p.id === AUTO_PLAN_ID
  return (
    <tr className="align-top">
      <td className="py-2.5 pr-3">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{p.name}</span>
          {p.createdVia === 'assistant' && (
            <Badge tone="violet" icon={<Bot className="h-3 w-3" />}>
              Assistant
            </Badge>
          )}
        </span>
        <span className="block text-xs text-muted">
          {isAuto ? 'Always the data as it is now' : `${p.kind === 'scenario' ? 'Scenario' : 'Plan'} by ${p.createdByName}, ${formatDateTime(p.updatedAt)}`}
        </span>
        {action.error && <span className="mt-1 block text-xs font-semibold text-danger-700 dark:text-danger-400">{action.error instanceof Error ? action.error.message : 'Failed.'}</span>}
      </td>
      <td className="py-2.5 pr-3">{isAuto ? <Badge tone="blue">live</Badge> : <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>}</td>
      <td className="py-2.5 pr-3 tabular-nums">{p.summary ? p.summary.lines.toLocaleString() : '—'}</td>
      <td className="py-2.5 pr-3 tabular-nums">{p.summary ? <span className={p.summary.late > 0 ? 'font-semibold text-danger-700 dark:text-danger-400' : ''}>{p.summary.late.toLocaleString()}</span> : '—'}</td>
      <td className="py-2.5 pr-3 tabular-nums">{p.summary ? pctLabel(p.summary.onTimePct) : '—'}</td>
      <td className="py-2.5 pr-3 tabular-nums">{p.summary ? tonnes(p.summary.lateWeightKg) : '—'}</td>
      <td className="py-2.5">
        <div className="flex flex-wrap gap-1.5">
          <Link to={`/planning/schedule?plan=${encodeURIComponent(p.id)}`} className="btn-secondary min-h-[40px] px-3" aria-label={`Schedule of ${p.name}`}>
            <CalendarClock className="h-4 w-4" />
          </Link>
          {!isAuto && (
            <Link to={`/planning/simulator?plan=${encodeURIComponent(p.id)}`} className="btn-secondary min-h-[40px] px-3" aria-label={`Compare ${p.name}`}>
              <FlaskConical className="h-4 w-4" />
            </Link>
          )}
          {!isAuto && can('publish-plan') && p.status === 'draft' && (
            <Button
              variant="primary"
              className="min-h-[40px] px-3"
              disabled={action.isPending}
              onClick={() => window.confirm(`Publish “${p.name}” as the factory’s plan?`) && action.mutate({ action: 'publish', version: p.version })}
            >
              <Send className="h-4 w-4" /> Publish
            </Button>
          )}
          {!isAuto && (p.status === 'draft' ? can('edit-planning') : p.status === 'published' && can('publish-plan')) && (
            <Button
              className="min-h-[40px] px-3"
              disabled={action.isPending}
              aria-label={`Archive ${p.name}`}
              onClick={() => (p.status !== 'published' || window.confirm('Archive the published plan? The factory then has no published plan.')) && action.mutate({ action: 'archive', version: p.version })}
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {!isAuto && can('edit-planning') && (p.status === 'draft' || p.status === 'archived') && (
            <Button
              variant="ghost"
              className="min-h-[40px] px-3 text-danger-700 dark:text-danger-400"
              disabled={action.isPending}
              aria-label={`Delete ${p.name}`}
              onClick={async () => {
                if (!window.confirm(`Delete “${p.name}”?`)) return
                await action.mutateAsync({ action: 'delete', version: p.version })
                navigate('/planning/plans', { replace: true })
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

export function PlansSection() {
  const { data, error, isLoading, refetch } = usePlans()
  const { can } = useAuth()
  const create = useCreatePlan()
  const [name, setName] = useState('')
  const [from, setFrom] = useState(AUTO_PLAN_ID)
  const [showArchived, setShowArchived] = useState(false)
  const plans = (data?.plans ?? []).filter((p) => showArchived || p.status !== 'archived')
  return (
    <div className="space-y-4">
      {can('edit-planning') && (
        <SectionCard title="Make a plan" hint="A plan starts as a copy of the automatic plan (or of another plan): change it in the Simulator, then publish it.">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              await create.mutateAsync({ kind: 'plan', name: name.trim(), fromId: from })
              setName('')
            }}
          >
            <div className="min-w-[220px] flex-1">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="Week 44 plan" className="min-h-[44px]" />
              </Field>
            </div>
            <Field label="From">
              <PlanPicker value={from} onChange={setFrom} label="Make it from" />
            </Field>
            <Button type="submit" variant="primary" className="min-h-[44px]" disabled={create.isPending || name.trim() === ''}>
              <Plus className="h-4 w-4" /> Make the plan
            </Button>
          </form>
          {create.error && <ErrorNote error={create.error} />}
        </SectionCard>
      )}
      <SectionCard
        title="Plans and scenarios"
        hint="Totals as each was last worked out. A published plan keeps its lines as they were published."
        actions={
          <label className="flex items-center gap-2 text-13 text-muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4" /> Archived too
          </label>
        }
      >
        {isLoading && <Loading what="Reading the plans" />}
        {error && <ErrorNote error={error} retry={() => void refetch()} />}
        {data && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-3 font-semibold">Plan</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">State</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Lines</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Late</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">On time</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Late weight</th>
                  <th scope="col" className="py-2 font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {plans.map((p) => (
                  <PlanRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}
