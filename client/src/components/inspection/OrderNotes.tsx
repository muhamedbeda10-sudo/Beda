import { MessageSquareText, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { formatDateTime } from '@/lib/utils'
import type { SessionNote } from '@qc/shared/types'

/**
 * Notes about an order, newest first: who wrote each one, when, on which
 * machine and while saving which sample, then the text and the photos. Used
 * on the Review step (every note on the order so far) and in History (the
 * notes of one session), so a remark reads the same everywhere.
 */
export function OrderNoteList({
  notes,
  emptyMessage,
  machineLabel,
  onDelete,
  deleting,
}: {
  notes: SessionNote[]
  emptyMessage: string
  /** Turns a machine code into what the factory calls it. */
  machineLabel?: (code: string) => string
  /** Offered only to roles allowed to mark a note deleted. */
  onDelete?: (note: SessionNote) => void
  deleting?: boolean
}) {
  if (notes.length === 0) {
    return <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-sm text-slate-400 dark:border-slate-700">{emptyMessage}</p>
  }
  return (
    <ul className="space-y-2">
      {notes.map((n) => (
        <li key={n.id} className="rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70 dark:bg-slate-800/50 dark:ring-slate-700">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="font-bold text-slate-700 dark:text-slate-200">{n.authorName}</span>
            <span>· {formatDateTime(n.createdAt)}</span>
            <span>
              · {machineLabel ? machineLabel(n.workCenterCode) : n.workCenterCode} · session #{n.sessionSeq}
              {n.sampleIndex ? ` · sample ${n.sessionSeq}-${n.sampleIndex}` : ''}
            </span>
            {onDelete && (
              <Button
                variant="ghost"
                className="ml-auto min-h-[40px] text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                disabled={deleting}
                onClick={() => onDelete(n)}
                aria-label="Delete note"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
          {n.text && (
            <p dir="auto" className="mt-1.5 whitespace-pre-wrap break-words text-sm font-medium text-slate-800 dark:text-slate-100">
              {n.text}
            </p>
          )}
          {n.imageIds.length > 0 && (
            <div className="mt-2">
              <ImagePicker imageIds={n.imageIds} onChange={() => {}} readOnly />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
