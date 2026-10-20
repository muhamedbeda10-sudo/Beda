// ============================================================================
// §25 — Plans: every plan and scenario with its totals, who made it (a person
// or the AI assistant), and what can be done with it: make a plan from the
// automatic one or from another, publish it as the factory's plan, archive
// it, delete a draft. The published plan is the one the floor follows and
// plan against actual measures; publishing another keeps it as superseded.
// ============================================================================

import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Archive, Bot, CalendarClock, ClipboardList, FlaskConical, Plus, Send, Trash2 } from 'lucide-react'
import { AUTO_PLAN_ID, type PlanHeader } from '@qc/shared/planning'
import { Badge, Button, EmptyState, Input } from '@/components/ui'
import { formatDateTime } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'
import { useCreatePlan, usePlanAction, usePlans } from '@/services/planning'
import { DataGrid, ErrorNote, Loading, PartFrame, PlanPicker, useGrid, type GridColumn } from './common'
import { pctLabel, tonnes } from './format'

const STATUS_TONE = {
  draft: 'blue',
  published: 'green',
  superseded: 'neutral',
  archived: 'neutral',
} as const
const kindName = (p: PlanHeader) => (p.id === AUTO_PLAN_ID ? 'Automatic' : p.kind === 'scenario' ? 'Scenario' : 'Plan')

function PlanActions({ p }: { p: PlanHeader }) {
  const { can } = useAuth()
  const action = usePlanAction(p.id)
  const navigate = useNavigate()
  const isAuto = p.id === AUTO_PLAN_ID
  return (
    <div className="flex flex-wrap gap-1.5">
      <Link to={`/planning/schedule?plan=${encodeURIComponent(p.id)}`} className="btn-secondary min-h-[36px] px-2.5" aria-label={`Schedule of ${p.name}`} data-tip="Its schedule">
        <CalendarClock className="h-4 w-4" />
      </Link>
      {!isAuto && (
        <Link to={`/planning/simulator?plan=${encodeURIComponent(p.id)}`} className="btn-secondary min-h-[36px] px-2.5" aria-label={`Compare ${p.name}`} data-tip="Open it in the simulator">
          <FlaskConical className="h-4 w-4" />
        </Link>
      )}
      {!isAuto && can('publish-plan') && p.status === 'draft' && (
        <Button
          variant="primary"
          className="min-h-[36px] px-2.5"
          disabled={action.isPending}
          onClick={() => window.confirm(`Publish “${p.name}” as the factory’s plan?`) && action.mutate({ action: 'publish', version: p.version })}
        >
          <Send className="h-4 w-4" /> Publish
        </Button>
      )}
      {!isAuto && (p.status === 'draft' ? can('edit-planning') : p.status === 'published' && can('publish-plan')) && (
        <Button
          className="min-h-[36px] px-2.5"
          disabled={action.isPending}
          aria-label={`Archive ${p.name}`}
          data-tip="Archive it"
          onClick={() =>
            (p.status !== 'published' || window.confirm('Archive the published plan? The factory then has no published plan.')) && action.mutate({ action: 'archive', version: p.version })
          }
        >
          <Archive className="h-4 w-4" />
        </Button>
      )}
      {!isAuto && can('edit-planning') && (p.status === 'draft' || p.status === 'archived') && (
        <Button
          variant="ghost"
          className="min-h-[36px] px-2.5 text-danger-700 dark:text-danger-400"
          disabled={action.isPending}
          aria-label={`Delete ${p.name}`}
          data-tip="Delete it"
          onClick={async () => {
            if (!window.confirm(`Delete “${p.name}”?`)) return
            await action.mutateAsync({
              action: 'delete',
              version: p.version,
            })
            navigate('/planning/plans', { replace: true })
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
      {action.error && <span className="basis-full text-xs font-semibold text-danger-700 dark:text-danger-400">{action.error instanceof Error ? action.error.message : 'Failed.'}</span>}
    </div>
  )
}

export function PlansSection() {
  const { data, error, isLoading, refetch } = usePlans()
  const { can } = useAuth()
  const create = useCreatePlan()
  const [name, setName] = useState('')
  const [from, setFrom] = useState(AUTO_PLAN_ID)
  const [showArchived, setShowArchived] = useState(false)
  const plans = useMemo(() => (data?.plans ?? []).filter((p) => showArchived || p.status !== 'archived'), [data, showArchived])
  const columns = useMemo<GridColumn<PlanHeader>[]>(
    () => [
      {
        key: 'name',
        label: 'Plan',
        value: (p) => p.name,
        noValues: true,
        cell: (p) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{p.name}</span>
            {p.createdVia === 'assistant' && (
              <Badge tone="violet" icon={<Bot className="h-3 w-3" />} tip="Kept by the AI assistant for a planner to review">
                Assistant
              </Badge>
            )}
          </span>
        ),
      },
      { key: 'kind', label: 'Kind', value: kindName, cell: kindName },
      {
        key: 'status',
        label: 'State',
        value: (p) => (p.id === AUTO_PLAN_ID ? 'live' : p.status),
        cell: (p) => (p.id === AUTO_PLAN_ID ? <Badge tone="blue">live</Badge> : <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>),
      },
      {
        key: 'by',
        label: 'By',
        value: (p) => (p.id === AUTO_PLAN_ID ? '' : p.createdByName),
        cell: (p) => (p.id === AUTO_PLAN_ID ? <span className="text-muted">The data as it is now</span> : p.createdByName),
      },
      {
        key: 'updated',
        label: 'Updated',
        value: (p) => (p.id === AUTO_PLAN_ID ? '' : formatDateTime(p.updatedAt)),
        sortValue: (p) => (p.id === AUTO_PLAN_ID ? null : p.updatedAt),
        noValues: true,
        cell: (p) => (p.id === AUTO_PLAN_ID ? '—' : formatDateTime(p.updatedAt)),
        className: 'whitespace-nowrap',
      },
      {
        key: 'changes',
        label: 'Changes',
        numeric: true,
        right: true,
        value: (p) => String(p.eventCount),
        sortValue: (p) => p.eventCount,
        cell: (p) => p.eventCount.toLocaleString(),
      },
      {
        key: 'lines',
        label: 'Lines',
        numeric: true,
        right: true,
        value: (p) => (p.summary ? String(p.summary.lines) : ''),
        sortValue: (p) => p.summary?.lines ?? null,
        cell: (p) => (p.summary ? p.summary.lines.toLocaleString() : '—'),
      },
      {
        key: 'late',
        label: 'Late',
        numeric: true,
        right: true,
        value: (p) => (p.summary ? String(p.summary.late) : ''),
        sortValue: (p) => p.summary?.late ?? null,
        cell: (p) => (p.summary ? <span className={p.summary.late > 0 ? 'font-semibold text-danger-700 dark:text-danger-400' : ''}>{p.summary.late.toLocaleString()}</span> : '—'),
      },
      {
        key: 'ontime',
        label: 'On time',
        numeric: true,
        right: true,
        value: (p) => (p.summary?.onTimePct === null || p.summary?.onTimePct === undefined ? '' : String(p.summary.onTimePct)),
        sortValue: (p) => p.summary?.onTimePct ?? null,
        cell: (p) => (p.summary ? pctLabel(p.summary.onTimePct) : '—'),
      },
      {
        key: 'weight',
        label: 'Late weight',
        numeric: true,
        right: true,
        value: (p) => (p.summary ? String(p.summary.lateWeightKg) : ''),
        sortValue: (p) => p.summary?.lateWeightKg ?? null,
        cell: (p) => (p.summary ? tonnes(p.summary.lateWeightKg) : '—'),
      },
      {
        key: 'actions',
        label: '',
        plain: true,
        value: () => '',
        cell: (p) => <PlanActions p={p} />,
      },
    ],
    [],
  )
  const view = useGrid(plans, columns)
  return (
    <PartFrame
      toolbar={
        <>
          {can('edit-planning') && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                await create.mutateAsync({
                  kind: 'plan',
                  name: name.trim(),
                  fromId: from,
                })
                setName('')
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
                placeholder="Name a new plan: Week 44"
                aria-label="Name of the new plan"
                className="h-10 w-56 py-0 text-sm touch:h-11"
              />
              <PlanPicker value={from} onChange={setFrom} label="Make it from" className="min-h-[40px]" />
              <Button
                type="submit"
                variant="primary"
                className="min-h-[40px]"
                disabled={create.isPending || name.trim() === ''}
                data-tip="A plan starts as a copy of the plan chosen: change it in the Simulator, then publish it"
              >
                <Plus className="h-4 w-4" /> Make the plan
              </Button>
              {create.error && <ErrorNote error={create.error} />}
            </form>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-13 text-muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4" /> Archived too
          </label>
        </>
      }
    >
      {isLoading ? (
        <Loading what="Reading the plans" />
      ) : error || !data ? (
        <div className="p-4">
          <ErrorNote error={error} retry={() => void refetch()} />
        </div>
      ) : (
        <DataGrid
          view={view}
          columns={columns}
          rowKey={(p) => p.id}
          total={plans.length}
          noun="plans"
          caption="Plans and scenarios"
          empty={<EmptyState icon={<ClipboardList className="h-10 w-10" />} title="No plan" hint="None matches the filters." />}
          footer={<span>Totals as each was last worked out; a published plan keeps its lines as they were published.</span>}
        />
      )}
    </PartFrame>
  )
}
