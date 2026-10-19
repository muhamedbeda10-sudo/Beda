// ============================================================================
// §20 — a chart in a finished answer: a query that asked to be drawn, as a
// figure of its own — its title, then the chart, with its tools under it as
// icons: Download image, Open table (the rows, large) and Export Excel. The
// query's card, with its SQL, stays under "How I got this".
// ============================================================================

import { memo, useState } from 'react'
import {
  Activity,
  CalendarDays,
  ChartCandlestick,
  Radar,
  Waypoints,
  ChartBarBig,
  ChartColumnBig,
  ChartColumnDecreasing,
  ChartColumnStacked,
  ChartGantt,
  ChartLine,
  ChartNoAxesCombined,
  ChartPie,
  ChartScatter,
  Filter,
  Gauge,
  Grid3x3,
  LayoutDashboard,
  SlidersHorizontal,
  Table2,
} from 'lucide-react'
import type { AiChartType, AiQueryPart } from '@qc/shared/ai'
import { AiChart } from './AiChart'
import { ChartImageTool } from './chartImage'
import { useAiExcel } from '@/services/queries'
import { EXPORT_TIP, useQueryExport } from './AiQueryCard'
import { AiResultModal } from './AiResultTable'
import { ExportTool, IconTool } from './AiTable'
import type { ChartModel } from './chartData'
import { textDirection } from './tables'

const ICON: Record<AiChartType, typeof ChartLine> = {
  line: ChartLine,
  area: ChartLine,
  'stacked-area': ChartLine,
  pie: ChartPie,
  bar: ChartColumnBig,
  'horizontal-bar': ChartBarBig,
  'stacked-bar': ChartColumnStacked,
  'stacked-bar-100': ChartColumnStacked,
  combo: ChartNoAxesCombined,
  pareto: ChartNoAxesCombined,
  scatter: ChartScatter,
  heatmap: Grid3x3,
  control: Activity,
  progress: Gauge,
  funnel: Filter,
  waterfall: ChartColumnDecreasing,
  gantt: ChartGantt,
  dumbbell: SlidersHorizontal,
  treemap: LayoutDashboard,
  histogram: ChartColumnBig,
  'xbar-r': Activity,
  'p-chart': Activity,
  'u-chart': Activity,
  'c-chart': Activity,
  'box-plot': ChartCandlestick,
  gauge: Gauge,
  radar: Radar,
  bubble: ChartScatter,
  sankey: Waypoints,
  calendar: CalendarDays,
  'risk-matrix': Grid3x3,
}

export const AiFigure = memo(function AiFigure({ part, model, question }: { part: AiQueryPart; model: ChartModel; question?: string }) {
  const [table, setTable] = useState(false)
  const { exporting, exportExcel } = useQueryExport(part, question, false)
  // Excel is for the people the assistant's owner allows (§20).
  const excel = useAiExcel()
  const Icon = ICON[model.type]
  const title = model.title ?? part.purpose
  const drawn = model.series.length
  // A measure split into series names what the legend's lines or bars are: "pieces, by machine".
  const split = model.measure && model.splitBy ? `${model.measure}, by ${model.splitBy}` : null
  const sub = [title !== part.purpose ? part.purpose : null, split].filter(Boolean).join(' · ')
  // The caption reads as its title does — an Arabic title from the right, its icon beside it there — and the line
  // under it sits with the title, whatever language its own words are in. A long word breaks rather than running off
  // the screen.
  return (
    <figure className="ai-figure my-3 rounded-2xl bg-white p-3 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800 sm:p-4">
      <figcaption dir={textDirection(title) ?? 'ltr'} className="mb-2 flex items-start gap-2.5">
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold leading-snug text-slate-900 dark:text-white [overflow-wrap:anywhere]">{title}</span>
          {sub && (
            <span className="block text-[11px] leading-snug text-muted [overflow-wrap:anywhere]">
              <bdi>{sub}</bdi>
            </span>
          )}
        </span>
      </figcaption>
      <AiChart model={model} />
      {(model.omitted > 0 || part.truncated) && (
        <p className="mt-1.5 text-[11px] text-muted">
          {model.omitted > 0 && `The ${drawn} largest of ${drawn + model.omitted} series are drawn; the table has them all. `}
          {part.truncated && `Drawn from the first ${part.rows.length.toLocaleString('en-US')} ${part.rows.length === 1 ? 'row' : 'rows'}; more matched — Export Excel has them all.`}
        </p>
      )}
      <div className="print-hidden mt-1.5 flex flex-wrap justify-end gap-0.5">
        <ChartImageTool model={model} title={title} iconOnly />
        <IconTool onClick={() => setTable(true)} disabled={part.rows.length === 0} label="Open table" tip="The chart's rows, in a large table" icon={<Table2 className="h-3.5 w-3.5" />} />
        {excel && <ExportTool onExport={exportExcel} exporting={exporting} tip={EXPORT_TIP} iconOnly />}
      </div>
      {table && <AiResultModal part={part} onClose={() => setTable(false)} onExport={excel ? exportExcel : undefined} exporting={exporting} />}
    </figure>
  )
})
