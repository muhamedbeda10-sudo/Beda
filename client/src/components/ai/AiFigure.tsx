// ============================================================================
// §20 — a chart in a finished answer: a query that asked to be drawn, as a
// figure of its own — its title, the chart, then the query's table with its
// tools (Copy table, Open table, Export Excel). The query's card, with its
// SQL, stays under "How I got this".
// ============================================================================

import { memo, useState } from 'react'
import { ChartColumnBig, ChartLine, ChartPie, Table2 } from 'lucide-react'
import { AI_PREVIEW_ROWS, type AiQueryPart } from '@qc/shared/ai'
import { AiChart } from './AiChart'
import { EXPORT_TIP, useQueryExport } from './AiQueryCard'
import { AiResultModal, PreviewTable } from './AiResultTable'
import { ExportTool, TableTool } from './AiTable'
import type { ChartModel } from './chartData'

const ICON = { line: ChartLine, area: ChartLine, pie: ChartPie, bar: ChartColumnBig, 'stacked-bar': ChartColumnBig } as const

export const AiFigure = memo(function AiFigure({ part, model, question }: { part: AiQueryPart; model: ChartModel; question?: string }) {
  const [table, setTable] = useState(false)
  const { exporting, exportExcel } = useQueryExport(part, question, false)
  const Icon = ICON[model.type]
  const title = model.title ?? part.purpose
  const drawn = model.series.length
  return (
    <figure className="my-3 rounded-2xl bg-white p-3 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800 sm:p-4">
      <figcaption className="mb-2 flex items-start gap-2.5">
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span dir="auto" className="block text-sm font-bold leading-snug text-slate-900 dark:text-white">
            {title}
          </span>
          {title !== part.purpose && (
            <span dir="auto" className="block text-[11px] leading-snug text-muted">
              {part.purpose}
            </span>
          )}
        </span>
      </figcaption>
      <AiChart model={model} />
      {(model.omitted > 0 || part.truncated) && (
        <p className="mt-1.5 text-[11px] text-muted">
          {model.omitted > 0 && `The ${drawn} largest of ${drawn + model.omitted} series are drawn; the table has them all. `}
          {part.truncated && `Drawn from the first ${AI_PREVIEW_ROWS} rows; more matched — Export Excel has them all.`}
        </p>
      )}
      <div className="mt-3">
        <PreviewTable
          part={part}
          className="max-h-64"
          tools={
            <>
              <TableTool onClick={() => setTable(true)} disabled={part.rows.length === 0} icon={<Table2 className="h-3.5 w-3.5" />}>
                Open table
              </TableTool>
              <ExportTool onExport={exportExcel} exporting={exporting} tip={EXPORT_TIP} />
            </>
          }
        />
      </div>
      {table && <AiResultModal part={part} onClose={() => setTable(false)} onExport={exportExcel} exporting={exporting} />}
    </figure>
  )
})
