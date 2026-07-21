import { useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  type TooltipProps,
} from 'recharts'
import {
  Activity,
  Boxes,
  Ruler,
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  BarChart3,
} from 'lucide-react'
import { useDB } from '@/store/db'
import { useApp } from '@/store/AppContext'
import {
  computeKpis,
  computeTrend,
  computeDefectBreakdown,
  computeMachinePerf,
} from '@/lib/analytics'
import { Card, Stat, EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils'

const WINDOWS = [7, 14, 30, 90] as const
type Window = (typeof WINDOWS)[number]

const COLORS = {
  brand: '#2563eb',
  pass: '#16a34a',
  fail: '#dc2626',
  warn: '#f59e0b',
}

export function AnalyticsPage() {
  const db = useDB()
  const { theme } = useApp()
  const [days, setDays] = useState<Window>(30)

  const kpis = useMemo(() => computeKpis(db, days), [db, days])
  const trend = useMemo(() => computeTrend(db, days), [db, days])
  const defects = useMemo(() => computeDefectBreakdown(db, days), [db, days])
  const machines = useMemo(() => computeMachinePerf(db, days), [db, days])

  const isDark = theme === 'dark'
  const axisStroke = '#94a3b8'
  const gridStroke = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(100,116,139,0.15)'

  const topDefects = useMemo(() => defects.slice(0, 8), [defects])

  const resultData = useMemo(
    () => [
      { name: 'Pass', value: kpis.passRate, color: COLORS.pass },
      { name: 'Fail', value: kpis.failRate, color: COLORS.fail },
      { name: 'Warning', value: kpis.warnRate, color: COLORS.warn },
    ],
    [kpis],
  )
  const hasResults = kpis.passRate + kpis.failRate + kpis.warnRate > 0

  const tooltipContentStyle = {
    background: isDark ? '#0f172a' : '#ffffff',
    border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
    borderRadius: 12,
    fontSize: 12,
    color: isDark ? '#e2e8f0' : '#0f172a',
    boxShadow: '0 8px 24px rgba(15,23,42,0.15)',
  }
  const tooltipLabelStyle = { color: isDark ? '#e2e8f0' : '#0f172a', fontWeight: 600 }
  const tooltipItemStyle = { color: isDark ? '#cbd5e1' : '#334155' }

  const commonTooltip = (
    <Tooltip
      contentStyle={tooltipContentStyle}
      labelStyle={tooltipLabelStyle}
      itemStyle={tooltipItemStyle}
      cursor={{ fill: 'rgba(148,163,184,0.08)' }}
    />
  )

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold leading-tight">Analytics</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            Quality performance overview · Last {days} days
          </p>
        </div>
        <div className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors',
                days === w
                  ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700 dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300',
              )}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Sessions"
          value={kpis.sessions}
          sub={`${kpis.openSessions} open`}
          icon={<Activity className="h-5 w-5" />}
          tone="blue"
        />
        <Stat
          label="Samples"
          value={kpis.samples}
          icon={<Boxes className="h-5 w-5" />}
          tone="violet"
        />
        <Stat
          label="Measurements"
          value={kpis.measurements}
          icon={<Ruler className="h-5 w-5" />}
          tone="neutral"
        />
        <Stat
          label="Defects"
          value={kpis.defects}
          sub={kpis.holdCount > 0 ? `${kpis.holdCount} on hold` : undefined}
          icon={<AlertTriangle className="h-5 w-5" />}
          tone={kpis.failRate >= 10 ? 'red' : 'amber'}
        />
        <Stat
          label="Pass rate"
          value={`${kpis.passRate}%`}
          sub={`${kpis.failRate}% fail · ${kpis.warnRate}% warn`}
          icon={<CheckCircle2 className="h-5 w-5" />}
          tone="green"
        />
        <Stat
          label="Open sessions"
          value={kpis.openSessions}
          icon={<FolderOpen className="h-5 w-5" />}
          tone={kpis.openSessions > 0 ? 'amber' : 'neutral'}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Trend */}
        <Card className="p-4">
          <ChartHeading title="Inspection trend" subtitle="Samples vs defects over time" />
          {trend.length === 0 ? (
            <NoData />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={trend} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gSamples" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.brand} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={COLORS.brand} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gDefects" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.fail} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={COLORS.fail} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke={axisStroke}
                  tick={{ fontSize: 11, fill: axisStroke }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={16}
                />
                <YAxis
                  stroke={axisStroke}
                  tick={{ fontSize: 11, fill: axisStroke }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={32}
                />
                {commonTooltip}
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="samples"
                  name="Samples"
                  stroke={COLORS.brand}
                  strokeWidth={2}
                  fill="url(#gSamples)"
                />
                <Area
                  type="monotone"
                  dataKey="defects"
                  name="Defects"
                  stroke={COLORS.fail}
                  strokeWidth={2}
                  fill="url(#gDefects)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Result mix donut */}
        <Card className="p-4">
          <ChartHeading title="Result mix" subtitle="Pass / fail / warning share" />
          {!hasResults ? (
            <NoData />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={resultData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={62}
                  outerRadius={92}
                  paddingAngle={2}
                  stroke="none"
                >
                  {resultData.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tooltipContentStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipItemStyle}
                  formatter={(v: number, n: string) => [`${v}%`, n]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Defect breakdown */}
        <Card className="p-4">
          <ChartHeading title="Top defects" subtitle="By quantity in window" />
          {topDefects.length === 0 ? (
            <NoData message="No defects in this window" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={topDefects}
                layout="vertical"
                margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
                <XAxis
                  type="number"
                  stroke={axisStroke}
                  tick={{ fontSize: 11, fill: axisStroke }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="title"
                  stroke={axisStroke}
                  tick={{ fontSize: 11, fill: axisStroke }}
                  tickLine={false}
                  axisLine={false}
                  width={120}
                />
                {commonTooltip}
                <Bar dataKey="qty" name="Qty" fill={COLORS.warn} radius={[0, 6, 6, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Machine performance */}
        <Card className="p-4">
          <ChartHeading title="Machine performance" subtitle="Pass vs fail samples" />
          {machines.length === 0 ? (
            <NoData />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={machines} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis
                  dataKey="code"
                  stroke={axisStroke}
                  tick={{ fontSize: 11, fill: axisStroke }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke={axisStroke}
                  tick={{ fontSize: 11, fill: axisStroke }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={32}
                />
                <Tooltip
                  contentStyle={tooltipContentStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipItemStyle}
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  content={<MachineTooltip />}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="pass" name="Pass" stackId="s" fill={COLORS.pass} radius={[0, 0, 0, 0]} maxBarSize={40} />
                <Bar dataKey="fail" name="Fail" stackId="s" fill={COLORS.fail} radius={[6, 6, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>
    </div>
  )
}

function ChartHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
        <BarChart3 className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-bold leading-tight">{title}</h3>
        {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
      </div>
    </div>
  )
}

function NoData({ message = 'No data in this window' }: { message?: string }) {
  return (
    <div className="py-6">
      <EmptyState icon={<BarChart3 className="h-8 w-8" />} title={message} />
    </div>
  )
}

function MachineTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0].payload as { machine: string; passRate: number }
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900">
      <p className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        {row.machine} <span className="text-slate-400">({label})</span>
      </p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: <b>{p.value}</b>
        </p>
      ))}
      <p className="mt-1 text-slate-500 dark:text-slate-400">Pass rate: {row.passRate}%</p>
    </div>
  )
}
