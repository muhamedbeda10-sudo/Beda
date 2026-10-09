// §20 — the header's door to the AI assistant: opens and closes the panel, and pulses while an answer is being written.

import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAi } from './AiAssistantProvider'

export function AiButton() {
  const { open, toggle, busy } = useAi()
  return (
    <button
      type="button"
      onClick={toggle}
      // A phone has no room for a fifth icon: there the assistant is in the menu.
      className={cn('icon-btn relative hidden sm:grid', open && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200')}
      aria-label={busy ? 'AI assistant, answering' : 'AI assistant'}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-tip={busy ? 'AI assistant — answering…' : 'AI assistant — ask about the data'}
    >
      <Bot className="h-5 w-5" />
      {busy && <AiBusyDot />}
    </button>
  )
}

/** The small pulsing dot that says an answer is still being written. */
export function AiBusyDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('absolute right-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-accent-500 ring-2 ring-white dark:ring-slate-900', className)} />
}
