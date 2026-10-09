// ============================================================================
// §20 — the two sides of a conversation. A question is a bubble on the right;
// an answer runs the panel's full width (its tables need it), led by the
// assistant's mark, its text and its query cards in the order they came,
// then how it ended, what it cost and a Copy. A saved message never changes,
// so it is memoised; the answer being written redraws once per frame.
// ============================================================================

import { memo, type ReactNode } from 'react'
import { Bot, Copy, RotateCcw } from 'lucide-react'
import type { AiMessage } from '@qc/shared/ai'
import { formatFullTimestamp, formatTime, cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { AiMarkdown } from './AiMarkdown'
import { AiQueryCard } from './AiQueryCard'
import { Notice, StopNotice } from './AiNotice'
import { formatUsd } from './format'
import { answerText, isInFlight, type LivePart, type LiveTurn } from './liveTurn'

/** The assistant's round mark. */
export function BotMark({ size = 'sm', className }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const box = { sm: 'h-7 w-7', md: 'h-9 w-9', lg: 'h-14 w-14' }[size]
  const icon = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-7 w-7' }[size]
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-card', box, className)}>
      <Bot className={icon} />
    </span>
  )
}

export function UserBubble({ text, at }: { text: string; at?: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3 py-2 text-sm text-white shadow-sm">
        <p dir="auto" className="whitespace-pre-wrap break-words">
          {text}
        </p>
        {at && (
          <time dateTime={at} data-tip={formatFullTimestamp(at)} className="mt-0.5 block text-end text-[10px] tabular-nums text-white/70">
            {formatTime(at)}
          </time>
        )}
      </div>
    </div>
  )
}

function AnswerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <BotMark className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  )
}

/** The parts of an answer in order: text as markdown, each query as its card. */
function AnswerParts({ parts, question }: { parts: readonly LivePart[]; question?: string }) {
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'text' ? <AiMarkdown key={i} text={p.text} /> : <AiQueryCard key={p.queryId} part={p} question={question} />,
      )}
    </>
  )
}

function AskAgain({ question, onAskAgain }: { question?: string; onAskAgain?: (q: string) => void }) {
  if (!question || !onAskAgain) return null
  return (
    <button type="button" onClick={() => onAskAgain(question)} className="inline-flex items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline">
      <RotateCcw className="h-3.5 w-3.5" /> Ask again
    </button>
  )
}

function AnswerFooter({ parts, costUsd, at }: { parts: readonly LivePart[]; costUsd?: number; at: string }) {
  const { toast } = useApp()
  const text = answerText(parts)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast('Answer copied.', 'success')
    } catch {
      toast('Could not copy — select the text and copy it by hand.', 'error')
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums text-muted">
      <time dateTime={at} data-tip={formatFullTimestamp(at)}>
        {formatTime(at)}
      </time>
      {costUsd !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span data-tip="What this answer cost, every call to the model it took">{formatUsd(costUsd)}</span>
        </>
      )}
      {text && (
        <button type="button" onClick={() => void copy()} className="ms-auto inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-semibold hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-10 touch:px-2.5" aria-label="Copy the answer">
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
      )}
    </div>
  )
}

/** A saved question or answer. `question` is the question an answer replies to, for its exports and Ask again. */
export const SavedMessage = memo(function SavedMessage({ message: m, question, onAskAgain }: { message: AiMessage; question?: string; onAskAgain?: (q: string) => void }) {
  if (m.role === 'user') {
    return <UserBubble text={answerText(m.parts)} at={m.createdAt} />
  }
  const retry = m.stopReason && m.stopReason !== 'end_turn' && m.stopReason !== 'refusal'
  return (
    <AnswerFrame>
      <AnswerParts parts={m.parts} question={question} />
      <StopNotice reason={m.stopReason} notice={m.notice} action={retry ? <AskAgain question={question} onAskAgain={onAskAgain} /> : undefined} />
      <AnswerFooter parts={m.parts} costUsd={m.costUsd} at={m.createdAt} />
    </AnswerFrame>
  )
})

/** The answer being written, or the last one until the saved conversation holds it. */
export function LiveAnswer({ turn, onAskAgain }: { turn: LiveTurn; onAskAgain?: (q: string) => void }) {
  const writing = isInFlight(turn)
  // Once done, the answer as saved; until then, as streamed.
  const parts = turn.phase === 'done' && turn.message ? turn.message.parts : turn.parts
  const last = parts.at(-1)
  // Between queries and before the first word, say what the model is doing.
  const working = writing && (turn.progress ?? (!last || last.type === 'query' ? (turn.phase === 'sending' ? 'Sending…' : 'Thinking…') : null))
  return (
    <AnswerFrame>
      <AnswerParts parts={parts} question={turn.question} />
      {working && (
        <p dir="auto" className="flex items-center gap-2 text-xs italic text-muted" aria-live="polite">
          <span aria-hidden className="flex shrink-0 gap-0.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 [animation-delay:300ms]" />
          </span>
          <span className="line-clamp-2">{working}</span>
        </p>
      )}
      {turn.phase === 'stopped' && <StopNotice reason="stopped" action={<AskAgain question={turn.question} onAskAgain={onAskAgain} />} />}
      {turn.phase === 'error' && (
        <Notice tone="red" action={<AskAgain question={turn.question} onAskAgain={onAskAgain} />}>
          {turn.error?.message ?? 'The answer could not be finished.'}
        </Notice>
      )}
      {turn.phase === 'done' && turn.message && (
        <>
          <StopNotice reason={turn.message.stopReason} notice={turn.message.notice} />
          <AnswerFooter parts={turn.message.parts} costUsd={turn.message.costUsd} at={turn.message.createdAt} />
        </>
      )}
    </AnswerFrame>
  )
}
