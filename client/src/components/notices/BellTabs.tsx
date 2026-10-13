// ============================================================================
// The bell's tabs: what it holds side by side — notices, alerts, reports,
// follow-ups and the person's tasks — each with its icon, its name and how many wait
// there, red when one of them is overdue. As many columns as there are tabs,
// so they never scroll out of sight in the bell's narrow drawer; with five,
// the names a size smaller, so "Follow-ups" still fits a phone's width.
// ============================================================================

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { badgeText } from './alerts'

export interface BellTabItem<T extends string> {
  value: T
  label: string
  icon: ReactNode
  /** How many wait there; nothing shown at 0. */
  count: number
  /** One of them is overdue: the count is red. */
  urgent?: boolean
}

export function BellTabs<T extends string>({ tabs, value, onChange, label, className }: { tabs: readonly BellTabItem<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={cn('grid gap-0.5 rounded-xl bg-slate-200/70 p-0.5 dark:bg-slate-800', className)} style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((t) => {
        const on = t.value === value
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.value)}
            className={cn(
              'relative flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 font-semibold transition-colors touch:min-h-[56px]',
              tabs.length >= 5 ? 'text-[11px] sm:text-xs' : 'text-xs',
              on ? 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300' : 'text-muted hover:text-slate-700 dark:hover:text-slate-200',
            )}
          >
            <span className="relative">
              {t.icon}
              {t.count > 0 && (
                <span
                  className={cn(
                    'absolute -right-3 -top-2 grid min-w-[16px] place-items-center rounded-full px-1 text-[10px] font-bold leading-4 text-white ring-2 ring-white dark:ring-slate-900',
                    t.urgent ? 'bg-rose-600' : 'bg-brand-600',
                  )}
                >
                  {badgeText(t.count)}
                </span>
              )}
            </span>
            <span className="max-w-full truncate">{t.label}</span>
            {t.count > 0 && <span className="sr-only">{`, ${t.count}${t.urgent ? ', some overdue' : ''}`}</span>}
          </button>
        )
      })}
    </div>
  )
}
