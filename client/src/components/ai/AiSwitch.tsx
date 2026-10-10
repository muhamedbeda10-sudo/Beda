// §20 — an on/off switch for the assistant's owner page: the assistant itself, and each person's use of it;
// §21 — and each automation's, in the Automations list.

import { cn } from '@/lib/utils'

/** Named by the element `labelledBy` points at, or by `label` where no such element is on screen. `tip`: its tooltip. */
export function AiSwitch({
  on,
  onChange,
  labelledBy,
  label,
  tip,
  disabled,
}: {
  on: boolean
  onChange: (on: boolean) => void
  labelledBy?: string
  label?: string
  tip?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      data-tip={tip}
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
