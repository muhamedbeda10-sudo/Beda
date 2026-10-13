// ============================================================================
// A playbook change the assistant made, as a small card in its answer: what
// it saved (an instruction, or a conclusion with its basis), changed or
// removed. The change is made already — it applies from then on — so the
// card offers Remove (while the entry is as it left it) and the Playbook
// page. Changed or removed since, it says so and offers nothing to press.
// ============================================================================

import { memo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, BookMarked, BookX, Loader2, Trash2 } from 'lucide-react'
import type { AiPlaybookPart } from '@qc/shared/playbook'
import { Badge } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { removePlaybookEntry } from '@/services/playbook'
import { useApp } from '@/store/AppContext'
import { useAi } from './AiAssistantProvider'
import { playbookCardState, playbookCardTitle } from './playbookCard'

export const AiPlaybookCard = memo(function AiPlaybookCard({ part }: { part: AiPlaybookPart }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { docked, setOpen } = useAi()
  const [busy, setBusy] = useState(false)
  // Removed from this card, until the conversation itself says so.
  const [removed, setRemoved] = useState(false)
  const shown: AiPlaybookPart = removed && part.state === 'current' ? { ...part, state: 'removed' } : part
  const since = playbookCardState(shown)
  const removal = shown.action === 'remove'
  const live = shown.state === 'current' && !removal
  // Only the person's own entries are removed from a card; one for everyone is the owner's, on the page.
  const mayRemove = live && shown.scope === 'personal'

  const remove = async () => {
    setBusy(true)
    try {
      await removePlaybookEntry(qc, shown.entryId)
      setRemoved(true)
      toast('Removed from your playbook.', 'success')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'It could not be removed. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const Icon = removal ? BookX : BookMarked
  return (
    <aside
      aria-label={playbookCardTitle(shown)}
      className={cn(
        'my-2 flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1',
        live ? 'bg-violet-50/70 ring-violet-200 dark:bg-violet-500/10 dark:ring-violet-500/30' : 'bg-slate-50 ring-slate-200 dark:bg-slate-800/40 dark:ring-slate-700',
      )}
    >
      <span aria-hidden className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg', live ? 'bg-violet-600 text-white' : 'bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200')}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          {playbookCardTitle(shown)}
          {since && <Badge tone="neutral">{since}</Badge>}
        </p>
        <p dir="auto" className={cn('mt-0.5 whitespace-pre-wrap break-words text-13 font-medium text-slate-800 dark:text-slate-100', (removal || shown.state === 'removed') && 'line-through decoration-slate-400')}>
          {shown.text}
        </p>
        {shown.basis && (
          <p dir="auto" className="mt-0.5 break-words text-xs text-muted">
            Basis: {shown.basis}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {live && <span className="text-muted">{shown.scope === 'shared' ? 'Followed for everyone given the assistant.' : 'Followed in your conversations from now on.'}</span>}
          {mayRemove && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="inline-flex items-center gap-1 font-semibold text-rose-700 hover:underline disabled:opacity-50 dark:text-rose-300 touch:min-h-[44px]"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Remove
            </button>
          )}
          <Link to="/playbook" onClick={() => !docked && setOpen(false)} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px]">
            Open playbook <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
          </Link>
        </p>
      </div>
    </aside>
  )
})
