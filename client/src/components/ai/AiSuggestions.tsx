// §20 — the follow-up questions under the latest answer, as chips. A tap puts the question in the box to send as it is or change first; it never sends by itself.

import { memo } from 'react'
import { CornerDownRight } from 'lucide-react'

export const AiSuggestions = memo(function AiSuggestions({ questions, onPick }: { questions: readonly string[]; onPick: (question: string) => void }) {
  if (questions.length === 0) return null
  return (
    <div role="group" aria-label="Ask next" className="space-y-1.5 pt-1">
      <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <CornerDownRight aria-hidden className="h-3.5 w-3.5" /> Ask next
      </p>
      <div className="flex flex-wrap gap-1.5">
        {questions.map((q) => (
          <button
            key={q}
            type="button"
            dir="auto"
            onClick={() => onPick(q)}
            data-tip="Put this question in the box"
            className="max-w-full rounded-2xl bg-white px-3 py-1.5 text-start text-xs font-medium leading-snug text-brand-800 shadow-sm ring-1 ring-brand-200 transition-colors hover:bg-brand-50 hover:ring-brand-300 dark:bg-slate-800 dark:text-brand-200 dark:ring-brand-500/30 dark:hover:bg-brand-500/15 touch:min-h-[44px] touch:py-2"
          >
            <span className="line-clamp-3 break-words">{q}</span>
          </button>
        ))}
      </div>
    </div>
  )
})
