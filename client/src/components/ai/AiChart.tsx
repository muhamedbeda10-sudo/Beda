// ============================================================================
// §20 — a query's chart, drawn with the dashboard's own SVG charts (§15): its
// palette, its axes and figures, its hover read-outs, both themes. Lines and
// areas for days and months, bars to compare, stacked bars and pies for what
// a whole is made of. Charts read left to right, in an Arabic answer too.
// ============================================================================

import { memo } from 'react'
import { GroupedBarChart, LineChart, PIE_CLASSES, PIE_STROKES, PieChart, StackedColumnChart } from '@/components/dashboard/charts'
import type { ChartModel } from './chartData'

/** The series' colours, in order: the dashboard's pie colours, so a line, a bar and a slice of one series match. */
const fillOf = (k: number) => PIE_CLASSES[k % (PIE_CLASSES.length - 1)]
const strokeOf = (k: number) => PIE_STROKES[k % (PIE_STROKES.length - 1)]

export const AiChart = memo(function AiChart({ model }: { model: ChartModel }) {
  const { labels, series, unit } = model
  let chart
  switch (model.type) {
    case 'line':
    case 'area':
      chart = <LineChart labels={labels} series={series.map((s, k) => ({ label: s.label, values: s.values, className: strokeOf(k) }))} unit={unit} height={220} connectGaps area={model.type === 'area'} />
      break
    case 'pie': {
      const values = series[0].values
      chart = (
        <PieChart
          centerLabel={series[0].label}
          unit={unit}
          slices={labels.map((label, i) => ({ label, value: values[i] ?? 0, className: fillOf(i) })).filter((s) => s.value > 0)}
        />
      )
      break
    }
    case 'stacked-bar':
      chart = (
        <StackedColumnChart
          columns={labels.map((label, i) => ({ label, segments: series.map((s, k) => ({ label: s.label, value: s.values[i] ?? 0, className: fillOf(k) })) }))}
          legend={series.map((s, k) => ({ label: s.label, className: fillOf(k) }))}
          unit={unit}
          height={220}
        />
      )
      break
    default:
      chart = <GroupedBarChart labels={labels} series={series.map((s, k) => ({ label: s.label, values: s.values, className: fillOf(k) }))} unit={unit} height={220} />
  }
  return <div dir="ltr">{chart}</div>
})
