// ============================================================================
// §25 — Planning (a trial): one tab, its parts as icons across the top,
// grouped by what a planner does — see the floor now, plan, set up — and the
// part itself filling the rest of the window, to its bottom edge and its full
// width. The page never scrolls: the shell gives it the whole room under the
// header (AppShell's main: h-full here, and contain: size so that nothing in
// it asks for more), each part's toolbar stays put and what is long (a table,
// a timeline, a map's tray) scrolls inside its card.
// Opened bare, it shows the overview. The module reads the order sheet, the
// production record and the inspections, and changes none of them.
// ============================================================================

import { Navigate, useParams } from 'react-router-dom'
import { AlarmClock, CalendarCheck, CalendarDays, ChartGantt, ClipboardList, DatabaseZap, Factory, FlaskConical, Gauge, Grid3x3, LayoutDashboard, Package, Route, SlidersHorizontal, Target } from 'lucide-react'
import { Badge } from '@/components/ui'
import { SectionTabs, type SectionTab } from '@/components/layout/SectionTabs'
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
import { QuoteSection } from '@/components/planning/QuoteSection'
import { CalendarSection, CapacitySection, GapsSection, RoutesSection, SettingsSection } from '@/components/planning/SetupSections'

type Group = 'now' | 'plan' | 'setup'

interface Part extends SectionTab {
  group: Group
  render: () => JSX.Element
}

export const PLANNING_PARTS: readonly Part[] = [
  {
    key: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    hint: 'Late lines, on-time share, load by process, the data’s freshness',
    group: 'now',
    render: () => <OverviewSection />,
  },
  {
    key: 'quote',
    label: 'Delivery date',
    icon: CalendarCheck,
    hint: 'When a new order could be delivered, and how to have an order done by a day',
    group: 'now',
    render: () => <QuoteSection />,
  },
  {
    key: 'floor',
    label: 'Factory map',
    icon: Factory,
    hint: 'Each factory’s machines, what each is on now and since when',
    group: 'now',
    render: () => <FloorSection />,
  },
  {
    key: 'late',
    label: 'Late lines',
    icon: AlarmClock,
    hint: 'The lines finishing after their due day, the latest first',
    group: 'now',
    render: () => <LateSection />,
  },
  {
    key: 'materials',
    label: 'Material',
    icon: Package,
    hint: 'Raw material each line waits for against when it would start',
    group: 'now',
    render: () => <MaterialsSection />,
  },
  {
    key: 'schedule',
    label: 'Schedule',
    icon: ChartGantt,
    hint: 'Every machine’s lines on a timeline, day by day',
    group: 'plan',
    render: () => <ScheduleSection />,
  },
  {
    key: 'load',
    label: 'Load',
    icon: Grid3x3,
    hint: 'Each machine’s planned hours against the hours it has, week by week',
    group: 'plan',
    render: () => <LoadSection />,
  },
  {
    key: 'simulator',
    label: 'Simulator',
    icon: FlaskConical,
    hint: 'What if a machine stops, a rush order comes, a Friday is worked…',
    group: 'plan',
    render: () => <SimulatorSection />,
  },
  {
    key: 'plans',
    label: 'Plans',
    icon: ClipboardList,
    hint: 'Make a plan, publish it as the factory’s, keep the ones before',
    group: 'plan',
    render: () => <PlansSection />,
  },
  {
    key: 'actual',
    label: 'Plan vs actual',
    icon: Target,
    hint: 'What the published plan asked of each machine, and what it made',
    group: 'plan',
    render: () => <ActualSection />,
  },
  {
    key: 'capacity',
    label: 'Capacity',
    icon: Gauge,
    hint: 'Hours each machine works a day, learnt or set',
    group: 'setup',
    render: () => <CapacitySection />,
  },
  {
    key: 'routes',
    label: 'Routes & paces',
    icon: Route,
    hint: 'Each item’s way through the factory, each machine’s pieces an hour',
    group: 'setup',
    render: () => <RoutesSection />,
  },
  {
    key: 'calendar',
    label: 'Calendar',
    icon: CalendarDays,
    hint: 'Holidays and Fridays worked',
    group: 'setup',
    render: () => <CalendarSection />,
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: SlidersHorizontal,
    hint: 'How the plan is worked out',
    group: 'setup',
    render: () => <SettingsSection />,
  },
  {
    key: 'gaps',
    label: 'Data gaps',
    icon: DatabaseZap,
    hint: 'What the data lacks, and what would close it',
    group: 'setup',
    render: () => <GapsSection />,
  },
]

const GROUPS: { id: Group; name: string }[] = [
  { id: 'now', name: 'The floor now' },
  { id: 'plan', name: 'Plan' },
  { id: 'setup', name: 'Setup' },
]

/** The overview is the tab opened bare; every other part has its own address. */
const pathOf = (key: string) => (key === 'overview' ? '/planning' : `/planning/${key}`)

export function PlanningPage() {
  const { section } = useParams()
  const { can } = useAuth()
  const current = PLANNING_PARTS.find((p) => p.key === (section ?? 'overview'))
  // The overview lives at the bare address; an unknown part goes there too.
  if (!current || section === 'overview') return <Navigate to="/planning" replace />
  const readOnly = !can('edit-planning') && ['simulator', 'plans'].includes(current.key)
  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 [contain:size]">
      <SectionTabs name="Planning" tabs={PLANNING_PARTS} groups={GROUPS} current={current} pathOf={pathOf} trailing={readOnly && <Badge tone="neutral">Read only</Badge>} />
      <div key={current.key} className="flex min-h-0 flex-1 flex-col animate-page-in">
        {current.render()}
      </div>
    </div>
  )
}
