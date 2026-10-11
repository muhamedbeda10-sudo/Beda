import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import type { ChatMention } from '@qc/shared/types'
import { cn } from '@/lib/utils'
import { segments } from './mentions'
import { appLinkSegments } from './appLinks'
import { messageDirection, textDirection } from '@/lib/direction'

/**
 * A message body with its mentions as chips. Tapping a chip opens the thing it names.
 * It reads the way its words do (messageDirection): a message in Arabic
 * that opens with an English word (a part's name) still wraps right to left,
 * which dir="auto" — going by the first letter — gets wrong.
 * §21 — with `appLinks` (the automations sender's messages): line by line, the app's addresses in the text opening in place.
 */
export function MessageBody({ body, mine, onMention, className, appLinks = false }: { body: string; mine: boolean; onMention: (m: ChatMention) => void; className?: string; appLinks?: boolean }) {
  if (appLinks) return <AutomatedBody body={body} mine={mine} className={className} />
  return (
    <span dir={messageDirection(body) ?? 'auto'} className={cn('block whitespace-pre-wrap break-words text-start', className)}>
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

/**
 * An automated message (no mentions): one line per case or bullet, each set
 * its own way — an Arabic case reads right to left in an English message and
 * the other way round. Its values are set apart with Unicode isolates, which
 * dir="auto" passes over, so the direction is decided from the letters.
 */
function AutomatedBody({ body, mine, className }: { body: string; mine: boolean; className?: string }) {
  return (
    <span className={cn('block whitespace-pre-wrap break-words', className)}>
      {body.split('\n').map((line, i) => (
        <span key={i} dir={textDirection(line) ?? 'auto'} className="block text-start">
          {line ? <AppLinkedText text={line} mine={mine} /> : '\u00a0'}
        </span>
      ))}
    </span>
  )
}

/** Text with the app's addresses in it as links named for what they open. */
function AppLinkedText({ text, mine }: { text: string; mine: boolean }) {
  return (
    <>
      {appLinkSegments(text).map((p, i) =>
        p.type === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <Link
            key={i}
            to={p.to}
            className={cn(
              'mx-0.5 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 align-baseline text-[0.92em] font-semibold leading-tight underline-offset-2 transition-colors hover:underline',
              mine ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-brand-50 text-brand-800 hover:bg-brand-100 dark:bg-brand-500/20 dark:text-brand-100 dark:hover:bg-brand-500/30',
            )}
          >
            {p.label}
            <ArrowUpRight className="h-3 w-3 rtl:-scale-x-100" aria-hidden />
          </Link>
        ),
      )}
    </>
  )
}
