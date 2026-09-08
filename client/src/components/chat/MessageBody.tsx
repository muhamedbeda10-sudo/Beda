import type { ChatMention } from '@qc/shared/types'
import { cn } from '@/lib/utils'
import { segments } from './mentions'

/** A message body with its mentions as chips. Tapping a chip opens the thing it names. */
export function MessageBody({ body, mine, onMention, className }: { body: string; mine: boolean; onMention: (m: ChatMention) => void; className?: string }) {
  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {segments(body).map((s, i) =>
        s.type === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onMention({ kind: s.kind, value: s.value, label: s.label })}
            className={cn(
              'mx-0.5 inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 align-baseline text-[0.92em] font-semibold leading-tight transition-colors',
              mine ? 'bg-white/20 text-white hover:bg-white/30' : s.kind === 'user' ? 'bg-brand-100 text-brand-800 hover:bg-brand-200 dark:bg-brand-500/20 dark:text-brand-100' : 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-100',
            )}
          >
            <span className="opacity-70">{s.sigil}</span>
            <span className="truncate">{s.label}</span>
          </button>
        ),
      )}
    </span>
  )
}
