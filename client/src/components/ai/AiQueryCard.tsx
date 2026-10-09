// ============================================================================
// §20 — a query the assistant ran, as a card in its answer: what it looked
// for, whether it worked, how many rows and how long. Opened, it shows the
// SQL and the rows the model read; the rows open as a table with Excel's
// filters, and Export Excel runs the query again in full for a workbook.
// ============================================================================

import { memo, useState } from 'react'
import { CheckCircle2, ChevronDown, CircleStop, Copy, FileSpreadsheet, Loader2, OctagonX, Table2 } from 'lucide-react'
import { AI_EXPORT_MAX_ROWS, AI_PREVIEW_ROWS, type AiQueryPart } from '@qc/shared/ai'
import { Badge } from '@/components/ui'
import { downloadWorkbook } from '@/lib/xlsxWrite'
import { cn } from '@/lib/utils'
import { loadAiQueryExport } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { aiExportFilename, aiResultSheets } from './exportAiResult'
import { AiResultModal, PreviewTable } from './AiResultTable'
import type { PendingQuery } from './liveTurn'

const SMALL_BTN = 'btn-secondary h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11 touch:px-3'

export const AiQueryCard = memo(function AiQueryCard({ part, question }: { part: AiQueryPart | PendingQuery; question?: string }) {
  const { toast } = useApp()
  const [open, setOpen] = useState(false)
  const [table, setTable] = useState(false)
  const [exporting, setExporting] = useState(false)

  const pending = part.type === 'pending-query'
  const running = pending && part.state === 'running'
  const done = pending ? null : part

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(part.sql)
      toast('SQL copied.', 'success')
    } catch {
      toast('Could not copy — select the SQL and copy it by hand.', 'error')
    }
  }

  const exportExcel = async () => {
    if (!done || exporting) return
    setExporting(true)
    try {
      const data = await loadAiQueryExport(done.queryId)
      downloadWorkbook(aiExportFilename(data.ranAt), aiResultSheets(data, question))
      const n = data.rows.length
      toast(data.truncated ? `Exported the first ${n.toLocaleString()} rows — the most an export takes.` : `Exported ${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the query.', 'error')
    } finally {
      setExporting(false)
    }
  }

  const icon = running ? (
    <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-300" />
  ) : pending ? (
    <CircleStop className="h-4 w-4 text-muted" />
  ) : done?.ok ? (
    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
  ) : (
    <OctagonX className="h-4 w-4 text-rose-600 dark:text-rose-400" />
  )

  const meta = running ? 'Running…' : pending ? 'Did not finish' : done?.ok ? `${done.rowCount.toLocaleString()}${done.truncated ? '+' : ''} ${done.rowCount === 1 && !done.truncated ? 'row' : 'rows'} · ${done.ms.toLocaleString()} ms` : `Failed · ${done?.ms.toLocaleString() ?? 0} ms`

  return (
    <div className={cn('my-2 overflow-hidden rounded-xl bg-white ring-1 dark:bg-slate-900', done && !done.ok ? 'ring-rose-200 dark:ring-rose-500/30' : 'ring-slate-200 dark:ring-slate-800')}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 touch:min-h-[44px]">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span dir="auto" className="line-clamp-2 block text-13 font-semibold text-slate-800 dark:text-slate-100">
            {part.purpose}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted">
            <span>{meta}</span>
            {done?.truncated && (
              <Badge tone="amber" tip={`More rows matched than the ${AI_PREVIEW_ROWS} the preview holds. Export Excel runs the query again for all of them (up to ${AI_EXPORT_MAX_ROWS.toLocaleString()}).`}>
                Truncated
              </Badge>
            )}
          </span>
        </span>
        <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-2 border-t border-slate-100 px-3 pb-3 pt-2 dark:border-slate-800">
          <div className="relative">
            <pre dir="ltr" className="max-h-56 overflow-auto rounded-lg bg-slate-900 p-2.5 pe-10 font-mono text-[11px] leading-relaxed text-slate-100 ring-1 ring-slate-800">
              {part.sql}
            </pre>
            <button type="button" onClick={() => void copySql()} aria-label="Copy the SQL" data-tip="Copy the SQL" className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white touch:h-10 touch:w-10">
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          {done && !done.ok && done.error && (
            <p dir="auto" className="whitespace-pre-wrap break-words rounded-lg bg-rose-50 px-2.5 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              {done.error}
            </p>
          )}
          {done?.ok && (
            <>
              <PreviewTable part={done} />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setTable(true)} className={SMALL_BTN} disabled={done.rows.length === 0}>
                  <Table2 className="h-3.5 w-3.5" /> Open table
                </button>
                <button type="button" onClick={() => void exportExcel()} className={SMALL_BTN} disabled={exporting} data-tip="Runs the query again now, in full, and saves it as a workbook">
                  {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} {exporting ? 'Exporting…' : 'Export Excel'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {table && done && <AiResultModal part={done} onClose={() => setTable(false)} onExport={() => void exportExcel()} exporting={exporting} />}
    </div>
  )
})
