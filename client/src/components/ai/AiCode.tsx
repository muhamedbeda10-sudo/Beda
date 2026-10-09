// ============================================================================
// §20 — code in the assistant's surfaces: a code block of an answer, a
// query's SQL. Left to right in a dark box, under a strip that says what it
// is and holds its Copy — apart from the code, so however wide a line runs,
// and on a phone's narrow column too, nothing is ever drawn over it.
// ============================================================================

import type { ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * `label`: what the code is ("SQL"); `copyLabel`: what Copy says to a screen
 * reader ("Copy the SQL"). The box's corners and margins are the caller's
 * (`className`), and so are the code's size and how tall it may grow
 * (`codeClassName`).
 */
export function AiCode({ label, onCopy, copyLabel, className, codeClassName, children }: { label: string; onCopy: () => void; copyLabel: string; className?: string; codeClassName?: string; children: ReactNode }) {
  return (
    <div dir="ltr" className={cn('overflow-hidden bg-slate-900 ring-1 ring-slate-800', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 ps-3 pe-1">
        <span className="min-w-0 truncate text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copyLabel}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 touch:h-10 touch:px-2.5"
        >
          <Copy aria-hidden className="h-3.5 w-3.5" /> Copy
        </button>
      </div>
      <pre dir="ltr" className={cn('overflow-auto font-mono leading-relaxed text-slate-100', codeClassName)}>
        {children}
      </pre>
    </div>
  )
}
