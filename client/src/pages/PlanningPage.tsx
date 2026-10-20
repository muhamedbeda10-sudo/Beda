// ============================================================================
// §25 — Planning (a trial): one tab, its parts as icons. Opened bare, it shows
// them all, grouped by what a planner does — see the floor now, plan, set up
// — each with a line of what it is; opened on a part, the icons run across
// the top to move between them (a select on a phone). The module reads the
// order sheet, the production record and the inspections, and changes none
// of them.
// ============================================================================

import { useEffect, useRef } from 'react'
import { Link, NavLink, Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  AlarmClock,
  CalendarDays,
  ChartGantt,
  ClipboardList,
  DatabaseZap,
  Factory,
  FlaskConical,
  Gauge,
  Grid3x3,
  LayoutDashboard,
  Package,
  Route,
  SlidersHorizontal,
  Sparkles,
  Target,
} from 'lucide-react'
import type { Permission } from '@qc/shared/permissions'
import { Badge, Button, Select } from '@/components/ui'
import { EdgeShadows, useScrollEdges } from '@/components/ui/ScrollX'
import { useAi } from '@/components/ai/AiAssistantProvider'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/AuthContext'
import { OverviewSection } from '@/components/planning/OverviewSection'
import { FloorSection } from '@/components/planning/FloorSection'
import { ScheduleSection } from '@/components/planning/ScheduleSection'
import { LoadSection } from '@/components/planning/LoadSection'
import { SimulatorSection } from '@/components/planning/SimulatorSection'
import { PlansSection } from '@/components/planning/PlansSection'
import { LateSection } from '@/components/planning/LateSection'
import { ActualSection } from '@/components/planning/ActualSection'
import { MaterialsSection } from '@/components/planning/MaterialsSection'
import { CalendarSection, CapacitySection, GapsSection, RoutesSection, SettingsSection } from '@/components/planning/SetupSections'

type Group = 'now' | 'plan' | 'setup'

interface Part {
  key: string
  label: string
  icon: typeof Factory
  /** What it shows, in a line, on the launcher. */
  hint: string
  group: Group
  render: () => JSX.Element
  /** A part only some may use; the rest see it read-only or not at all. */
  needs?: Permission
}

export const PLANNING_PARTS: readonly Part[] = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard, hint: 'Late lines, on-time share, load by process, the data’s freshness', group: 'now', render: () => <OverviewSection /> },
  { key: 'floor', label: 'Factory map', icon: Factory, hint: 'Each factory’s machines, what each is on now and since when', group: 'now', render: () => <FloorSection /> },
  { key: 'late', label: 'Late lines', icon: AlarmClock, hint: 'The lines finishing after their due day, the latest first', group: 'now', render: () => <LateSection /> },
  { key: 'materials', label: 'Material', icon: Package, hint: 'Raw material each line waits for against when it would start', group: 'now', render: () => <MaterialsSection /> },
  { key: 'schedule', label: 'Schedule', icon: ChartGantt, hint: 'Every machine’s lines on a timeline, day by day', group: 'plan', render: () => <ScheduleSection /> },
  { key: 'load', label: 'Load', icon: Grid3x3, hint: 'Each machine’s planned hours against the hours it has, week by week', group: 'plan', render: () => <LoadSection /> },
  { key: 'simulator', label: 'Simulator', icon: FlaskConical, hint: 'What if a machine stops, a rush order comes, a Friday is worked…', group: 'plan', render: () => <SimulatorSection /> },
  { key: 'plans', label: 'Plans', icon: ClipboardList, hint: 'Make a plan, publish it as the factory’s, keep the ones before', group: 'plan', render: () => <PlansSection /> },
  { key: 'actual', label: 'Plan vs actual', icon: Target, hint: 'What the published plan asked of each machine, and what it made', group: 'plan', render: () => <ActualSection /> },
  { key: 'capacity', label: 'Capacity', icon: Gauge, hint: 'Hours each machine works a day, learnt or set', group: 'setup', render: () => <CapacitySection /> },
  { key: 'routes', label: 'Routes & paces', icon: Route, hint: 'Each item’s way through the factory, each machine’s pieces an hour', group: 'setup', render: () => <RoutesSection /> },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays, hint: 'Holidays and Fridays worked', group: 'setup', render: () => <CalendarSection /> },
  { key: 'settings', label: 'Settings', icon: SlidersHorizontal, hint: 'How the plan is worked out', group: 'setup', render: () => <SettingsSection /> },
  { key: 'gaps', label: 'Data gaps', icon: DatabaseZap, hint: 'What the data lacks, and what would close it', group: 'setup', render: () => <GapsSection /> },
]

const GROUPS: { id: Group; name: string; hint: string }[] = [
  { id: 'now', name: 'The floor now', hint: 'From the open inspections, the order sheet and the production record.' },
  { id: 'plan', name: 'Plan', hint: 'The automatic plan, the plans you make, and what if.' },
  { id: 'setup', name: 'Setup', hint: 'What the plan rests on: learnt from the record, or set by the planners.' },
]

function Launcher() {
  return (
    <div className="space-y-6">
      {GROUPS.map((g) => (
        <section key={g.id} aria-labelledby={`planning-group-${g.id}`}>
          <h2 id={`planning-group-${g.id}`} className="text-base font-bold">
            {g.name}
          </h2>
          <p className="mb-3 text-13 text-muted">{g.hint}</p>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {PLANNING_PARTS.filter((p) => p.group === g.id).map((p) => (
              <li key={p.key}>
                <Link
                  to={`/planning/${p.key}`}
                  className="group flex h-full flex-col gap-3 rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition-shadow hover:shadow-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:bg-slate-900 dark:ring-slate-800"
                >
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-600 group-hover:text-white dark:bg-brand-500/15 dark:text-brand-300 dark:group-hover:bg-brand-500 dark:group-hover:text-white">
                    <p.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-semibold text-slate-900 dark:text-white">{p.label}</span>
                    <span className="mt-0.5 block text-13 leading-snug text-muted">{p.hint}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function PartSwitch({ current }: { current: Part }) {
  const navigate = useNavigate()
  const strip = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(strip)
  useEffect(() => {
    strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [current.key])
  return (
    <>
      <Select aria-label="Planning part" value={current.key} onChange={(e) => navigate(`/planning/${e.target.value}`)} className="min-h-[48px] sm:hidden">
        {GROUPS.map((g) => (
          <optgroup key={g.id} label={g.name}>
            {PLANNING_PARTS.filter((p) => p.group === g.id).map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <nav aria-label="Planning parts" className="relative hidden sm:block">
        <div ref={strip} className="scrollbar-none flex gap-0.5 overflow-x-auto rounded-xl bg-slate-200/70 p-0.5 dark:bg-slate-800">
          {PLANNING_PARTS.map((p, i) => (
            <span key={p.key} className="flex shrink-0 items-center">
              {i > 0 && PLANNING_PARTS[i - 1].group !== p.group && <span aria-hidden className="mx-1 h-6 w-px bg-slate-300 dark:bg-slate-700" />}
              <NavLink
                to={`/planning/${p.key}`}
                className={({ isActive }) =>
                  cn(
                    'group inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-13 font-semibold transition-colors duration-200 touch:h-11',
                    isActive ? 'bg-white text-brand-800 shadow-sm dark:bg-slate-900 dark:text-white' : 'text-muted hover:text-brand-700 dark:hover:text-white',
                  )
                }
              >
                <p.icon className="h-4 w-4 shrink-0" aria-hidden />
                {p.label}
              </NavLink>
            </span>
          ))}
        </div>
        <EdgeShadows {...edges} />
      </nav>
    </>
  )
}

export function PlanningPage() {
  const { section = '' } = useParams()
  const ai = useAi()
  const { can } = useAuth()
  const current = PLANNING_PARTS.find((p) => p.key === section)
  if (section && !current) return <Navigate to="/planning" replace />
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/planning" className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300" aria-label="All of planning">
          <ChartGantt className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1 basis-[220px]">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-extrabold tracking-tight">
            Planning
            <Badge tone="violet" tip="A trial: it reads the order sheet, the production record and the inspections, and changes none of them">
              Trial
            </Badge>
          </h1>
          <p className="text-13 text-muted">{current ? current.hint : 'The factory’s plan from its own data: where every order line runs, when it is done, and what if.'}</p>
        </div>
        {ai.enabled && (
          <Button
            className="min-h-[44px] w-full sm:w-auto"
            onClick={() => ai.compose('Planning: ')}
            data-tip="Ask the assistant about the plan, or have it try a what-if: “What if machine 24 stops from Sunday 08:00 to Tuesday?”"
          >
            <Sparkles className="h-4 w-4" /> Ask the assistant
          </Button>
        )}
        {!can('edit-planning') && current && ['simulator', 'plans'].includes(current.key) && <Badge tone="neutral">Read only</Badge>}
      </header>
      {current ? (
        <>
          <PartSwitch current={current} />
          <div key={current.key} className="animate-page-in">
            {current.render()}
          </div>
        </>
      ) : (
        <Launcher />
      )}
    </div>
  )
}
