// ============================================================================
// §20 — a query's chart, drawn with the dashboard's own SVG charts (§15) and
// the assistant's own kinds beside them (./AiChartKinds): their palette,
// axes and figures, hover read-outs, both themes. Lines and areas for days
// and months, bars (upright or lying) to compare, stacks and pies for what a
// whole is made of, bars with lines on two axes, a Pareto of causes, a
// scatter with its trend, a heatmap, an SPC control chart, and for planning
// and production (./AiPlanCharts) progress toward targets, a funnel, a
// waterfall, a gantt, a dumbbell and a treemap. Charts read left to right,
// in an Arabic answer too.
//
// The dashboard draws on a 720-wide canvas scaled to its card; the answer's
// column is narrower in the panel (about 420 px) and wider on the full page,
// so a chart here is drawn at about the width it is shown — its words stay
// near their own size instead of shrinking to a few pixels — and as many
// names go along x as that width holds. And where the dashboard's figures are
// ones it knows, a query may return any: so they are written in full
// (chartFigure: "1,284", "0.0012"), on an axis fitted to them, with the room
// their figures and names take (the charts' `fitted`).
// ============================================================================

import { memo, useLayoutEffect, useRef, useState } from 'react'
import { GroupedBarChart, LineChart, PIE_CLASSES, PIE_STROKES, PieChart, StackedColumnChart } from '@/components/dashboard/charts'
import { ComboChart, ControlChart, HeatmapChart, HorizontalBarChart, ParetoAiChart, ScatterChart, StackedAreaChart } from './AiChartKinds'
import { DumbbellChart, FunnelChart, GanttChart, ProgressChart, TreemapChart, WaterfallChart } from './AiPlanCharts'
import { aiChartWidth, chartFigure, percentStack, type ChartModel } from './chartData'

/** The series' colours, in order: the dashboard's pie colours, so a line, a bar and a slice of one series match. */
const fillOf = (k: number) => PIE_CLASSES[k % (PIE_CLASSES.length - 1)]
const strokeOf = (k: number) => PIE_STROKES[k % (PIE_STROKES.length - 1)]

/** The plot's height, before the room slanted names take. */
const HEIGHT = 220

/** Now on this device's clock, read as a chart reads the factory's (parseChartDate): a gantt's "Today". */
function wallNow(): number {
  const n = new Date()
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes())
}

/**
 * The width to draw at, for the width the chart is shown at — read before the
 * first paint, and again as it changes (the panel expanded to the page, a
 * phone turned). Drawn in steps (aiChartWidth), so a resize by a pixel draws
 * nothing again.
 */
function useDrawingWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => aiChartWidth(null))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(aiChartWidth(el.clientWidth))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(read)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  return { ref, width }
}

export const AiChart = memo(function AiChart({ model }: { model: ChartModel }) {
  const { ref, width } = useDrawingWidth()
  const { labels, series, unit, goal } = model
  let chart
  switch (model.type) {
    case 'line':
    case 'area':
      chart = (
        <LineChart
          labels={labels}
          series={series.map((s, k) => ({ label: s.label, values: s.values, className: strokeOf(k) }))}
          unit={unit}
          height={HEIGHT}
          width={width}
          connectGaps
          area={model.type === 'area'}
          fitted
          format={chartFigure}
          goal={goal}
        />
      )
      break
    case 'stacked-area':
      chart = <StackedAreaChart labels={labels} series={series} strokes={strokeOf} unit={unit} width={width} height={HEIGHT} format={chartFigure} />
      break
    case 'horizontal-bar':
      chart = <HorizontalBarChart labels={labels} series={series} classes={fillOf} unit={unit} width={width} format={chartFigure} goal={goal} />
      break
    case 'combo':
      chart = <ComboChart labels={labels} series={series} fills={fillOf} strokes={strokeOf} unit={unit} lineUnit={model.lineUnit ?? ''} width={width} height={HEIGHT} format={chartFigure} goal={goal} />
      break
    case 'pareto':
      chart = (
        <ParetoAiChart labels={labels} values={series[0].values} cumulative={model.cumulative ?? []} label={series[0].label} unit={unit} width={width} height={HEIGHT} format={chartFigure} />
      )
      break
    case 'scatter':
      chart = <ScatterChart groups={model.scatter ?? []} fills={fillOf} xName={model.xName ?? ''} yName={model.yName ?? ''} unit={unit} width={width} height={HEIGHT} format={chartFigure} goal={goal} />
      break
    case 'heatmap':
      chart = <HeatmapChart labels={labels} rows={series} unit={unit} width={width} format={chartFigure} />
      break
    case 'control':
      chart = model.control ? (
        <ControlChart labels={labels} values={series[0].values} limits={model.control} label={series[0].label} unit={unit} width={width} height={HEIGHT} format={chartFigure} goal={goal} />
      ) : null
      break
    case 'progress':
      chart = <ProgressChart labels={labels} done={series[0].values} targets={model.targets ?? []} percentMode={!!model.percentMode} unit={unit} width={width} format={chartFigure} />
      break
    case 'funnel':
      chart = <FunnelChart labels={labels} values={series[0].values} unit={unit} width={width} format={chartFigure} />
      break
    case 'waterfall':
      chart = <WaterfallChart labels={labels} values={series[0].values} unit={unit} width={width} height={HEIGHT + 20} format={chartFigure} />
      break
    case 'gantt':
      chart = model.gantt ? <GanttChart labels={labels} gantt={model.gantt} fills={fillOf} width={width} today={wallNow()} /> : null
      break
    case 'dumbbell':
      chart =
        series.length === 2 ? (
          <DumbbellChart labels={labels} first={series[0].values} second={series[1].values} names={[series[0].label, series[1].label]} unit={unit} width={width} format={chartFigure} goal={goal} />
        ) : null
      break
    case 'treemap':
      chart = <TreemapChart labels={labels} series={series} grouped={!!model.splitBy} fills={fillOf} unit={unit} width={width} format={chartFigure} />
      break
    case 'stacked-bar-100': {
      const shares = percentStack(series, labels.length)
      chart = (
        <StackedColumnChart
          columns={labels.map((label, i) => ({ label, segments: shares.map((s, k) => ({ label: s.label, value: s.values[i] ?? 0, className: fillOf(k) })) }))}
          legend={shares.map((s, k) => ({ label: s.label, className: fillOf(k) }))}
          unit="%"
          height={HEIGHT}
          width={width}
          fitted
          format={chartFigure}
          showTotals={false}
        />
      )
      break
    }
    case 'pie': {
      const values = series[0].values
      // The legend beside the pie, not across the whole width of the page: each figure stays near its name.
      chart = (
        <div className="max-w-lg">
          <PieChart
            centerLabel={series[0].label}
            unit={unit}
            slices={labels.map((label, i) => ({ label, value: values[i] ?? 0, className: fillOf(i) })).filter((s) => s.value > 0)}
            format={chartFigure}
          />
        </div>
      )
      break
    }
    case 'stacked-bar':
      chart = (
        <StackedColumnChart
          columns={labels.map((label, i) => ({ label, segments: series.map((s, k) => ({ label: s.label, value: s.values[i] ?? 0, className: fillOf(k) })) }))}
          legend={series.map((s, k) => ({ label: s.label, className: fillOf(k) }))}
          unit={unit}
          height={HEIGHT}
          width={width}
          fitted
          format={chartFigure}
        />
      )
      break
    default:
      chart = (
        <GroupedBarChart labels={labels} series={series.map((s, k) => ({ label: s.label, values: s.values, className: fillOf(k) }))} unit={unit} height={HEIGHT} width={width} format={chartFigure} goal={goal} />
      )
  }
  return (
    <div ref={ref} dir="ltr" className="min-w-0">
      {chart}
    </div>
  )
})
