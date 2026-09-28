// ============================================================================
// §4 — the stage of a session on a universal machine: one item of an order
// passes through several stages on the machine, a session each. A later
// session is given one of the item's stages, or the next one.
// ============================================================================

import type { SessionStagesResponse } from '@qc/shared/api'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'

export function StagePicker({ options, value, onChange }: { options: SessionStagesResponse; value: number | null; onChange: (stage: number) => void }) {
  const choices = [
    ...options.stages.map((s) => ({ stage: s.stage, label: `Stage ${s.stage}`, sub: `${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'} so far — more of the same stage` })),
    { stage: options.next, label: `Stage ${options.next}`, sub: 'A new stage of this item' },
  ]
  return (
    <div role="radiogroup" aria-label="Stage" className="grid gap-2 sm:grid-cols-2">
      {choices.map((c) => {
        const on = value === c.stage
        return (
          <button
            key={c.stage}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(c.stage)}
            className={cn(
              'flex min-h-[56px] flex-col items-start justify-center rounded-xl px-3 py-2 text-left ring-1 transition-colors',
              on ? 'bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-500/10' : 'bg-white ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:ring-slate-700 dark:hover:bg-slate-800',
            )}
          >
            <span className="font-bold">{c.label}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{c.sub}</span>
          </button>
        )
      })}
    </div>
  )
}

/** "Stage 2" beside a session that is a later stage of its item; nothing for stage 1 or any other machine. */
export function StageBadge({ stage }: { stage?: number }) {
  if (!stage || stage < 2) return null
  return <Badge tone="violet">Stage {stage}</Badge>
}
