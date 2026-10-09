// §20 — an on/off switch for the assistant's owner page: the assistant itself, and each person's use of it.

import { cn } from '@/lib/utils'

export function AiSwitch({ on, onChange, labelledBy, disabled }: { on: boolean; onChange: (on: boolean) => void; labelledBy: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-slate-900',
        on ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600',
      )}
    >
      <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200', on ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  )
}
