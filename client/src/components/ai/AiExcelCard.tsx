// ============================================================================
// §20 — an Excel file the assistant made, as a card in its answer: the file's
// name and size, each sheet with its columns and rows, and Download, which
// saves the very file the server made (kept AI_EXCEL_KEEP_DAYS days; the
// server says so once it is gone). The file is kept the moment the card
// comes, so Download works while the answer is still being written.
// ============================================================================

import { memo, useState } from 'react'
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react'
import { AI_EXCEL_KEEP_DAYS, type AiExcelPart } from '@qc/shared/aiExcel'
import { Button } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn, formatDate, saveBlob } from '@/lib/utils'
import { loadAiExcelFile } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { formatBytes } from './attachments'

/** Columns a sheet names on the card before "+N more". */
const SHOWN_COLUMNS = 8

/** A sheet's rows as the card says them: "1 row", "57 rows". */
export const excelRowCount = (rows: number): string => `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`

/** Until when the file can be downloaded, or that it no longer can. */
export function excelKeptLine(part: Pick<AiExcelPart, 'expired' | 'expiresAt'>): string {
  return part.expired ? `No longer kept: files are kept ${AI_EXCEL_KEEP_DAYS} days. Ask again for a new one.` : `Kept until ${formatDate(part.expiresAt)}.`
}

export const AiExcelCard = memo(function AiExcelCard({ part }: { part: AiExcelPart }) {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  // Gone on the server since the card was drawn: said once a download finds it so.
  const [gone, setGone] = useState(false)
  const expired = !!part.expired || gone

  const download = async () => {
    if (busy || expired) return
    setBusy(true)
    try {
      saveBlob(`${part.fileName}.xlsx`, await loadAiExcelFile(part.fileId))
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) setGone(true)
      toast(e instanceof Error ? e.message : 'The file could not be downloaded. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside
      aria-label={`Excel file: ${part.fileName}`}
      className={cn(
        'my-2 flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1',
        expired ? 'bg-slate-50 ring-slate-200 dark:bg-slate-800/40 dark:ring-slate-700' : 'bg-emerald-50/70 ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/30',
      )}
    >
      <span aria-hidden className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg', expired ? 'bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200' : 'bg-emerald-600 text-white')}>
        <FileSpreadsheet className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Excel file · {formatBytes(part.byteSize)}</p>
        {/* The name alone: ".xlsx" beside an Arabic name reads out of place, and the line above says what it is. */}
        <p dir="auto" className="mt-0.5 break-words text-13 font-semibold text-slate-800 dark:text-slate-100">
          {part.fileName}
        </p>
        <ul className="mt-1.5 space-y-1.5">
          {part.sheets.map((s, i) => (
            <li key={i} className="text-xs">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span dir="auto" className="font-semibold text-slate-700 dark:text-slate-200">
                  {s.name}
                </span>
                <span className="text-muted">
                  {s.columns.length} {s.columns.length === 1 ? 'column' : 'columns'} · {excelRowCount(s.rows)}
                </span>
              </p>
              {s.title && (
                <p dir="auto" className="break-words text-muted">
                  {s.title}
                </p>
              )}
              <p className="mt-0.5 flex flex-wrap gap-1">
                {s.columns.slice(0, SHOWN_COLUMNS).map((c, k) => (
                  <span
                    key={k}
                    dir="auto"
                    className="max-w-[12rem] truncate rounded-md bg-white px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-emerald-100 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-emerald-500/20"
                  >
                    {c}
                  </span>
                ))}
                {s.columns.length > SHOWN_COLUMNS && <span className="px-1 py-0.5 text-[11px] text-muted">+{s.columns.length - SHOWN_COLUMNS} more</span>}
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {!expired && (
            <Button variant="primary" className="min-h-[40px] touch:min-h-[44px]" onClick={() => void download()} disabled={busy} aria-busy={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download Excel
            </Button>
          )}
          <span className="text-xs text-muted">{excelKeptLine({ expired, expiresAt: part.expiresAt })}</span>
        </div>
      </div>
    </aside>
  )
})
