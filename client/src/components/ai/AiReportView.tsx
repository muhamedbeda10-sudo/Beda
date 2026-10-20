// ============================================================================
// §20 — one saved report, run now, in the assistant's popup (My reports).
// Opening it runs every section's SQL through the server's read-only runner
// (no model, no cost) and shows each as a report reads (ReportRunBody): its
// title, its figures, chart or rows in full, a large table with Excel's
// filters. What the report and each section are about sits behind an info
// button, out of the way; the SQL stays in the conversation it came from, not
// here. On the full page it takes the page's width. Export Excel takes every
// section in full, a sheet each, after a sheet on the report itself, drawn in
// the report's style (the server makes it); Print draws it in that style too.
// Only its maker renames or deletes a report, chooses its style, adds its
// Excel forms and shares it with people and roles (Share: they run it on
// their Reports page, the assistant or not); a report shared with everyone
// given the assistant says whose it is, and anyone who opens it fills its
// forms.
// ============================================================================

import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Info, MessageSquareText, Pencil, Share2, Trash2, Users } from 'lucide-react'
import type { AiReport, AiReportSummary } from '@qc/shared/ai'
import { Badge, Button } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn, saveBlob } from '@/lib/utils'
import { deleteAiReport, renameAiReport } from '@/services/mutations'
import { keys, useAiExcel, useAiReport, useAiReportRun } from '@/services/queries'
import { loadReportWorkbook } from '@/services/reportStyles'
import { ReportLookPanel } from '@/components/reportStyles/ReportLookPanel'
import { useApp } from '@/store/AppContext'
import { useAi } from './AiAssistantProvider'
import { Notice } from './AiNotice'
import { DeleteReportModal, ReportTitleEditor } from './AiReportList'
import { aiReportFilename } from './exportAiReport'
import { ReportRunBody, useReportRunState } from './ReportRunBody'
import { ReportSharePanel } from './ReportSharePanel'

export function AiReportView({
  id,
  known,
  onBack,
  onOpenConversation,
  wide = false,
  sharing: startSharing = false,
}: {
  id: string
  /** What the list knew of it: drawn until the report itself arrives. */
  known?: AiReportSummary
  onBack: () => void
  onOpenConversation: (conversationId: string) => void
  /** The full page: the report takes the page's width. */
  wide?: boolean
  /** Open on its Share panel (an answer's share card). */
  sharing?: boolean
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { enabled } = useAi()
  const detail = useAiReport(id, enabled)
  const loaded: AiReport | undefined = detail.data
  const state = useReportRunState(loaded?.inputs, known?.inputCount)
  const run = useAiReportRun(id, state.override, state.inputsJson, enabled && state.canRun)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [exporting, setExporting] = useState(false)
  // What the report is about (its description, or the question it came from): behind the info button.
  const [about, setAbout] = useState(false)
  // Whom it is shared with: behind the Share button, its maker's alone.
  const [sharing, setSharing] = useState(startSharing)

  const report: AiReport | AiReportSummary | undefined = detail.data ?? run.data?.report ?? known
  const full: AiReport | undefined = detail.data ?? run.data?.report
  const shown = run.data
  const gone = detail.error instanceof ApiError && detail.error.status === 404

  const rename = async (title: string): Promise<boolean> => {
    try {
      await renameAiReport(qc, id, title)
      setRenaming(false)
      toast('Report renamed.', 'success')
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not rename the report.', 'error')
      return false
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteAiReport(qc, id)
      toast('Report deleted.', 'success')
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the report.', 'error')
      setDeleting(false)
    }
  }

  // Over the days on screen: the saved period as of now, or the days chosen; drawn by the server in the report's style.
  const title = report?.title
  const { override, inputsJson } = state
  const exportExcel = useCallback(async () => {
    setExporting(true)
    try {
      const file = await loadReportWorkbook(id, override, inputsJson)
      saveBlob(aiReportFilename(qc.getQueryData<AiReport>(keys.aiReport(id))?.title ?? title ?? 'Report', new Date().toISOString()), file)
      // Its last run moved.
      void qc.invalidateQueries({ queryKey: keys.aiReports })
      toast('Exported the report to Excel, in its style.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export the report.', 'error')
    } finally {
      setExporting(false)
    }
  }, [id, override, inputsJson, qc, toast, title])
  const onExport = useCallback(() => void exportExcel(), [exportExcel])
  // Excel is for the people the assistant's owner allows (§20).
  const excel = useAiExcel()
  const sqlOf = useCallback((i: number) => shown?.report.sections[i]?.sql ?? '', [shown])
  const shareCount = full?.shareCount ?? 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('flex shrink-0 items-center gap-1 border-b border-slate-100 px-2 py-2 dark:border-slate-800', wide && 'sm:px-4 lg:px-6')}>
        <button type="button" onClick={onBack} className="icon-btn h-9 w-9 shrink-0 touch:h-11 touch:w-11" aria-label="Back to My reports" data-tip="My reports">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </button>
        {renaming && report ? (
          <ReportTitleEditor initial={report.title} onSave={rename} onCancel={() => setRenaming(false)} />
        ) : (
          <>
            {/* Two lines, then cut: one line cut short splits a figure in an Arabic title ("آخر 30 يوم" read as "آخر 0…"). */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 px-1">
              <h3 dir="auto" className={cn('line-clamp-2 min-w-0 break-words text-start font-bold leading-snug', wide ? 'text-base' : 'text-sm')} data-tip={report?.title}>
                {report?.title ?? 'Report'}
              </h3>
              {report?.shared && (
                <Badge tone="blue" tip="Everyone given the assistant may open it; each sees the data they may read">
                  <Users className="h-3 w-3" /> Shared
                </Badge>
              )}
              {report && !report.mine && (
                <span dir="auto" className="text-[11px] text-muted">
                  by {report.ownerName}
                </span>
              )}
            </div>
            {report && !gone && (
              <button
                type="button"
                onClick={() => setAbout((a) => !a)}
                aria-expanded={about}
                className={cn('icon-btn h-9 w-9 shrink-0 touch:h-11 touch:w-11', about && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300')}
                aria-label="About this report"
                data-tip="About this report"
              >
                <Info className="h-4 w-4" />
              </button>
            )}
            {report && !gone && report.mine && (
              <>
                <button
                  type="button"
                  onClick={() => setSharing((s) => !s)}
                  aria-expanded={sharing}
                  className={cn('icon-btn relative h-9 w-9 shrink-0 touch:h-11 touch:w-11', sharing && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300')}
                  aria-label={shareCount > 0 ? `Share: shared with ${shareCount}` : 'Share'}
                  data-tip={shareCount > 0 ? `Shared with ${shareCount} ${shareCount === 1 ? 'person or role' : 'people and roles'}` : 'Share with people and roles'}
                >
                  <Share2 className="h-4 w-4" />
                  {shareCount > 0 && (
                    <span aria-hidden className="absolute -right-0.5 -top-0.5 grid min-w-[16px] place-items-center rounded-full bg-brand-600 px-1 text-[10px] font-bold leading-4 text-white ring-2 ring-white dark:ring-slate-900">
                      {shareCount}
                    </span>
                  )}
                </button>
                <button type="button" onClick={() => setRenaming(true)} className="icon-btn h-9 w-9 shrink-0 touch:h-11 touch:w-11" aria-label="Rename the report" data-tip="Rename">
                  <Pencil className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setRemoving(true)} className="icon-btn h-9 w-9 shrink-0 hover:text-rose-600 touch:h-11 touch:w-11" aria-label="Delete the report" data-tip="Delete">
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4', wide && 'ai-report sm:px-6 lg:px-8 lg:py-5')}>
        <div className={cn('w-full', wide ? 'space-y-4' : 'space-y-3')}>
          {gone ? (
            <Notice
              tone="red"
              action={
                <Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={onBack}>
                  <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" /> My reports
                </Button>
              }
            >
              This report could not be found. It may have been deleted.
            </Notice>
          ) : (
            <>
              {report && about && (
                <div className="space-y-1.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-800">
                  <p dir="auto" className="whitespace-pre-wrap break-words text-13 text-slate-700 dark:text-slate-200">
                    {report.description || report.question}
                  </p>
                  {full?.conversationId && (
                    <button
                      type="button"
                      onClick={() => onOpenConversation(full.conversationId!)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]"
                    >
                      <MessageSquareText className="h-3.5 w-3.5" /> Open the conversation
                    </button>
                  )}
                </div>
              )}

              {report?.mine && sharing && <ReportSharePanel reportId={id} />}

              <ReportRunBody
                state={state}
                run={run}
                inputs={full?.inputs ?? []}
                report={report}
                sectionCount={full?.sections.length ?? known?.sectionCount ?? 2}
                sectionTitles={full?.sections.map((s) => s.title) ?? []}
                sqlOf={sqlOf}
                excel={excel ? { onExport, exporting } : null}
                look={full && <ReportLookPanel report={full} run={shown} range={override} inputs={inputsJson} excel={excel} canRun={state.canRun} />}
                wide={wide}
              />
            </>
          )}
        </div>
      </div>

      {removing && report && <DeleteReportModal report={report} busy={deleting} onCancel={() => setRemoving(false)} onConfirm={() => void remove()} />}
    </div>
  )
}
