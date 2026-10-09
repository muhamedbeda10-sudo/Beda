// ============================================================================
// §20 — an answer's headline figures as a row of compact cards above its
// text: the label, the value as the model wrote it in figures of one width,
// and, when it said how the figure moved, an arrow — green when the move is
// good news, red when it is bad, grey when it held. As many to a row as the
// width holds: two in the panel, all six across on the full page. Figures
// labelled in Arabic run from the right, as the answer under them reads.
// A value is shown whole, on a phone too, where no pointer can ask for a
// tooltip: a figure stays large, and a longer value (words, as "LM4
// Painting Line") is set a size smaller and wraps.
// ============================================================================

import { memo } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { AiKpi } from '@qc/shared/ai'
import { cn } from '@/lib/utils'
import { kpiTrendView } from './kpis'
import { textDirection } from './tables'

const TONE = {
  good: 'text-emerald-600 dark:text-emerald-400',
  bad: 'text-rose-600 dark:text-rose-400',
  neutral: 'text-muted',
} as const

const ACCENT = {
  good: 'before:bg-emerald-500',
  bad: 'before:bg-rose-500',
  neutral: 'before:bg-brand-500',
} as const

/** The longest value set at the cards' full size: a figure ("12,345,678", "1.29%"), a short word. */
const KPI_SHORT_VALUE = 10

export const AiKpiCards = memo(function AiKpiCards({ kpis }: { kpis: readonly AiKpi[] }) {
  if (kpis.length === 0) return null
  return (
    <ul aria-label="Headline figures" dir={textDirection(kpis.map((k) => k.label).join(' ')) ?? 'ltr'} className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2 pb-1">
      {kpis.map((k) => {
        const trend = kpiTrendView(k.trend)
        const Arrow = trend?.direction === 'up' ? ArrowUpRight : trend?.direction === 'down' ? ArrowDownRight : Minus
        return (
          <li
            key={k.label}
            className={cn(
              'relative min-w-0 overflow-hidden rounded-xl bg-white px-3 py-2 shadow-card ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800',
              "before:absolute before:inset-y-0 before:start-0 before:w-1 before:content-['']",
              ACCENT[trend?.tone ?? 'neutral'],
            )}
          >
            <p dir="auto" className="line-clamp-2 text-[11px] font-semibold leading-tight text-muted" data-tip={k.label.length > 28 ? k.label : undefined}>
              {k.label}
            </p>
            <p className="mt-1 flex min-w-0 items-baseline gap-1.5">
              <span
                dir="auto"
                className={cn(
                  'min-w-0 break-words font-extrabold text-slate-900 tabular-nums dark:text-white',
                  Array.from(k.value).length > KPI_SHORT_VALUE ? 'text-[15px] leading-snug' : 'text-lg leading-tight',
                )}
              >
                {k.value}
              </span>
              {trend && (
                <span className={cn('inline-flex shrink-0 items-center', TONE[trend.tone])}>
                  <Arrow aria-hidden className="h-4 w-4" strokeWidth={2.5} />
                  <span className="sr-only">{trend.words}</span>
                </span>
              )}
            </p>
          </li>
        )
      })}
    </ul>
  )
})
