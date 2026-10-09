// ============================================================================
// §20 — a query's chart, drawn with the dashboard's own SVG charts (§15): its
// palette, its axes and figures, its hover read-outs, both themes. Lines and
// areas for days and months, bars to compare, stacked bars and pies for what
// a whole is made of. Charts read left to right, in an Arabic answer too.
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
import { aiChartWidth, chartFigure, type ChartModel } from './chartData'

/** The series' colours, in order: the dashboard's pie colours, so a line, a bar and a slice of one series match. */
const fillOf = (k: number) => PIE_CLASSES[k % (PIE_CLASSES.length - 1)]
const strokeOf = (k: number) => PIE_STROKES[k % (PIE_STROKES.length - 1)]

/** The plot's height, before the room slanted names take. */
const HEIGHT = 220

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
  const { labels, series, unit } = model
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
        />
      )
      break
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
      chart = <GroupedBarChart labels={labels} series={series.map((s, k) => ({ label: s.label, values: s.values, className: fillOf(k) }))} unit={unit} height={HEIGHT} width={width} format={chartFigure} />
  }
  return (
    <div ref={ref} dir="ltr" className="min-w-0">
      {chart}
    </div>
  )
})
