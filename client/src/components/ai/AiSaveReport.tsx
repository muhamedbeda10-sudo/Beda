// ============================================================================
// §20 — "Save as report" under an answer that ran a query that worked. The
// whole answer is kept: each of its working queries becomes a section, to
// run again any day from My reports. Saving asks the model once to make the
// question's period changeable ("last 30 days" stays the last 30 days); when
// that cannot be done the report keeps the period as asked, and says so here
// once. With this month's limit reached, it can still be saved as asked,
// which needs no call to the model.
// ============================================================================

import type { ReactNode } from 'react'
import { useMutationState, useQueryClient, type MutationState } from '@tanstack/react-query'
import { BookmarkCheck, BookmarkPlus, Info, Loader2 } from 'lucide-react'
import type { AiMessage, AiSaveReportRequest, AiSaveReportResponse } from '@qc/shared/ai'
import { Button } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { startSavingAiReport } from '@/services/mutations'
import { keys } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { Notice } from './AiNotice'
import { AI_REPORT_FIXED_TEXT, canSaveAsReport, saveAsReportState } from './reports'

const FOOTER_BTN = 'inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-semibold hover:bg-slate-100 hover:text-slate-700 disabled:cursor-default disabled:opacity-70 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-10 touch:px-2.5'

const saveState = (m: { state: unknown }) => m.state as MutationState<AiSaveReportResponse, Error, AiSaveReportRequest>

/**
 * The button for an answer's footer and the word it may leave under it.
 * `message`: the answer once it has ended (null while it is written). What a
 * save has come to is read from the query client (startSavingAiReport), not
 * kept here: the answer is drawn again from scratch each time the thread
 * comes back, and a save on its way must still show as one.
 */
export function useSaveAsReport(message: AiMessage | null, onOpenReport?: (id: string) => void): { button: ReactNode; notice: ReactNode } {
  const qc = useQueryClient()
  const { toast } = useApp()
  const saves = useMutationState({ filters: { mutationKey: keys.aiSaveReport(message?.turnId ?? ''), exact: true }, select: saveState })
  const { saving, savedId, fixedWhy, budgetSpent } = saveAsReportState(saves)

  if (!message || !canSaveAsReport(message)) return { button: null, notice: null }
  const turnId = message.turnId!
  // The conversation as cached carries the mark once saved (and loses it when the report is deleted); the save, until then.
  const reportId = message.savedReportId ?? savedId

  const save = (adjustable: boolean) => {
    const done = startSavingAiReport(qc, adjustable ? { turnId } : { turnId, adjustable: false })
    // Null: this answer is being saved already.
    if (!done) return
    done.then(
      () => toast('Saved to My reports.', 'success'),
      (e: unknown) => {
        // A monthly limit is reached: making the period adjustable needs the model, saving it as asked does not — offered below the answer.
        if (adjustable && e instanceof ApiError && e.code === 'ai_budget_reached') return
        toast(e instanceof Error ? e.message : 'Could not save the report.', 'error')
      },
    )
  }

  const button = reportId ? (
    <button
      type="button"
      onClick={() => onOpenReport?.(reportId)}
      disabled={!onOpenReport}
      className={cn(FOOTER_BTN, 'text-brand-700 dark:text-brand-300')}
      data-tip="Saved under My reports: open it"
    >
      <BookmarkCheck className="h-3.5 w-3.5" /> Saved · Open
    </button>
  ) : (
    <button
      type="button"
      onClick={() => save(true)}
      disabled={saving !== null}
      className={FOOTER_BTN}
      data-tip={saving ? undefined : "Keep this answer's queries as a report to run again any day"}
      aria-live="polite"
    >
      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
      {saving === 'adjustable' ? 'Making the period adjustable…' : saving === 'fixed' ? 'Saving…' : 'Save as report'}
    </button>
  )

  const notice =
    budgetSpent && !reportId ? (
      <Notice
        tone="amber"
        action={
          <Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => save(false)} disabled={saving !== null}>
            {saving === 'fixed' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />} Save with the period as asked
          </Button>
        }
      >
        This month's limit for the assistant is reached, so the report's period cannot be made adjustable now. It can still be saved with the period fixed as asked.
      </Notice>
    ) : fixedWhy && reportId ? (
      <Notice tone="neutral" icon={Info}>
        {AI_REPORT_FIXED_TEXT} <span className="opacity-80">{fixedWhy}</span>
      </Notice>
    ) : null

  return { button, notice }
}
