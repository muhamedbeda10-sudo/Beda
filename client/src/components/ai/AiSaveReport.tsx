// ============================================================================
// §20 — "Save as report" under an answer that ran a query that worked. The
// whole answer is kept: each of its working queries becomes a section, to
// run again any day from My reports. Saving asks the model once to make the
// question's period changeable ("last 30 days" stays the last 30 days); when
// that cannot be done the report keeps the period as asked, and says so here
// once. With the month's budget spent, it can still be saved as asked,
// which needs no call to the model.
// ============================================================================

import { useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BookmarkCheck, BookmarkPlus, Info, Loader2 } from 'lucide-react'
import type { AiMessage } from '@qc/shared/ai'
import { Button } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { saveAiReport } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { Notice } from './AiNotice'
import { AI_REPORT_FIXED_TEXT, canSaveAsReport } from './reports'

const FOOTER_BTN = 'inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-semibold hover:bg-slate-100 hover:text-slate-700 disabled:cursor-default disabled:opacity-70 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-10 touch:px-2.5'

/**
 * The button for an answer's footer and the word it may leave under it.
 * `message`: the answer once it has ended (null while it is written).
 */
export function useSaveAsReport(message: AiMessage | null, onOpenReport?: (id: string) => void): { button: ReactNode; notice: ReactNode } {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [saving, setSaving] = useState<'adjustable' | 'fixed' | null>(null)
  // Saved from here, until the conversation as cached carries the mark (it is then the one source, so a delete clears it).
  const [savedId, setSavedId] = useState<string | null>(null)
  const [fixedWhy, setFixedWhy] = useState<string | null>(null)
  const [budgetSpent, setBudgetSpent] = useState(false)

  const marked = message?.savedReportId
  useEffect(() => {
    if (savedId && marked === savedId) setSavedId(null)
  }, [marked, savedId])

  if (!message || !canSaveAsReport(message)) return { button: null, notice: null }
  const turnId = message.turnId!
  const reportId = marked ?? savedId

  const save = async (adjustable: boolean) => {
    if (saving) return
    setSaving(adjustable ? 'adjustable' : 'fixed')
    setBudgetSpent(false)
    try {
      const res = await saveAiReport(qc, adjustable ? { turnId } : { turnId, adjustable: false })
      setSavedId(res.report.id)
      setFixedWhy(adjustable && !res.report.adjustable && res.notice ? res.notice : null)
      toast('Saved to My reports.', 'success')
    } catch (e) {
      // The cap is reached: making the period adjustable needs the model, saving it as asked does not.
      if (adjustable && e instanceof ApiError && e.code === 'ai_budget_reached') setBudgetSpent(true)
      else toast(e instanceof Error ? e.message : 'Could not save the report.', 'error')
    } finally {
      setSaving(null)
    }
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
      onClick={() => void save(true)}
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
          <Button className="h-8 min-h-0 px-3 py-0 text-xs touch:h-11" onClick={() => void save(false)} disabled={saving !== null}>
            {saving === 'fixed' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />} Save with the period as asked
          </Button>
        }
      >
        This month's budget is spent, so the report's period cannot be made adjustable now. It can still be saved with the period fixed as asked.
      </Notice>
    ) : fixedWhy && reportId ? (
      <Notice tone="neutral" icon={Info}>
        {AI_REPORT_FIXED_TEXT} <span className="opacity-80">{fixedWhy}</span>
      </Notice>
    ) : null

  return { button, notice }
}
