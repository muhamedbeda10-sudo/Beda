// §20 — the inline words on how an answer ended when it did not simply finish, and on why the assistant cannot answer now.

import type { ReactNode } from 'react'
import { AlertTriangle, CircleStop, Info, OctagonX } from 'lucide-react'
import type { AiStopReason, AiUnavailableReason } from '@qc/shared/ai'
import { cn } from '@/lib/utils'
import { STOP_TEXT, UNAVAILABLE_TEXT } from './format'

type Tone = 'neutral' | 'amber' | 'red'

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  amber: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
  red: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25',
}

const ICONS: Record<Tone, typeof Info> = { neutral: CircleStop, amber: AlertTriangle, red: OctagonX }

const STOP_TONE: Record<Exclude<AiStopReason, 'end_turn'>, Tone> = {
  stopped: 'neutral',
  max_tokens: 'amber',
  refusal: 'amber',
  limit: 'amber',
  cap: 'red',
  error: 'red',
}

export function Notice({ tone, children, action, className }: { tone: Tone; children: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = ICONS[tone]
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-xl px-3 py-2 text-13', TONES[tone], className)}>
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p dir="auto">{children}</p>
        {action && <div className="mt-1.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  )
}

/** How an answer ended: the server's own words when it sent some, else the default for the reason. */
export function StopNotice({ reason, notice, action }: { reason: AiStopReason | undefined; notice?: string; action?: ReactNode }) {
  if (!reason || reason === 'end_turn') {
    return notice ? (
      <Notice tone="neutral" action={action}>
        {notice}
      </Notice>
    ) : null
  }
  return (
    <Notice tone={STOP_TONE[reason]} action={action}>
      {notice || STOP_TEXT[reason]}
    </Notice>
  )
}

/** Why nothing can be asked right now. */
export function UnavailableNotice({ reason, action }: { reason: AiUnavailableReason; action?: ReactNode }) {
  return (
    <Notice tone={reason === 'cap-reached' ? 'red' : 'amber'} action={action}>
      {UNAVAILABLE_TEXT[reason]}
    </Notice>
  )
}
