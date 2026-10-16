// ============================================================================
// §20 — photos in a finished answer: a query that found photos (./photos),
// as a figure of its own like a chart's — what it looked for, how many
// photos, the gallery; Open table and Export Excel under it. Its card, with
// its SQL, stays under "How I got this".
// ============================================================================

import { memo, useMemo, useState } from 'react'
import { Camera, Table2 } from 'lucide-react'
import type { AiQueryPart } from '@qc/shared/ai'
import { useAiExcel } from '@/services/queries'
import { AiPhotoGallery } from './AiPhotoGallery'
import { EXPORT_TIP, useQueryExport } from './AiQueryCard'
import { AiResultModal } from './AiResultTable'
import { ExportTool, TableTool } from './AiTable'
import { photoCount, queryPhotos } from './photos'
import { textDirection } from './tables'

export const AiPhotoFigure = memo(function AiPhotoFigure({ part, question }: { part: AiQueryPart; question?: string }) {
  const photos = useMemo(() => queryPhotos(part) ?? [], [part])
  const [table, setTable] = useState(false)
  const { exporting, exportExcel } = useQueryExport(part, question, false)
  // Excel is for the people the assistant's owner allows (§20).
  const excel = useAiExcel()
  return (
    <figure className="ai-figure my-3 rounded-2xl bg-white p-3 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800 sm:p-4">
      <figcaption dir={textDirection(part.purpose) ?? 'ltr'} className="mb-2.5 flex items-start gap-2.5">
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <Camera className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold leading-snug text-slate-900 dark:text-white">{part.purpose}</span>
          <span className="block text-[11px] tabular-nums leading-snug text-muted">
            {photoCount(photos.length)}
            {part.truncated && ' (the first found; more matched)'}
          </span>
        </span>
      </figcaption>
      <AiPhotoGallery photos={photos} />
      <div className="print-hidden mt-2 flex flex-wrap justify-end gap-1 text-xs text-muted">
        <TableTool onClick={() => setTable(true)} disabled={part.rows.length === 0} icon={<Table2 className="h-3.5 w-3.5" />}>
          Open table
        </TableTool>
        {excel && <ExportTool onExport={exportExcel} exporting={exporting} tip={EXPORT_TIP} />}
      </div>
      {table && <AiResultModal part={part} onClose={() => setTable(false)} onExport={excel ? exportExcel : undefined} exporting={exporting} />}
    </figure>
  )
})
