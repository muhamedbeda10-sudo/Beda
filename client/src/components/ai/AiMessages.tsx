// ============================================================================
// §20 — the two sides of a conversation. A question is a bubble on the right;
// an answer runs the panel's full width (its tables need it), led by the
// assistant's mark, its text and its query cards in the order they came,
// then how it ended, what it cost, Save as report and a Copy; the latest
// answer also offers the questions the model suggests asking next. A saved
// message changes only when it is saved as a report, so it is memoised; the
// answer being written redraws once per frame.
// ============================================================================

import { memo, useMemo, type ReactNode } from 'react'
import { Bot, Copy, RotateCcw } from 'lucide-react'
import type { AiMessage } from '@qc/shared/ai'
import { formatFullTimestamp, formatTime, cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { AiMarkdown } from './AiMarkdown'
import { AiQueryCard } from './AiQueryCard'
import { Notice, StopNotice } from './AiNotice'
import { useSaveAsReport } from './AiSaveReport'
import { AiSuggestions } from './AiSuggestions'
import { formatUsd } from './format'
import { answerText, isInFlight, type LivePart, type LiveTurn } from './liveTurn'
import { liveDisplayParts, suggestionChips } from './suggestions'

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

export const UserBubble = memo(function UserBubble({ text, at }: { text: string; at?: string }) {
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
})

function AnswerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <BotMark className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  )
}

/** The parts of an answer in order: text as markdown, each query as its card. `writing`: the answer is not finished. */
function AnswerParts({ parts, question, writing }: { parts: readonly LivePart[]; question?: string; writing: boolean }) {
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'text' ? <AiMarkdown key={i} text={p.text} /> : <AiQueryCard key={p.queryId} part={p} question={question} writing={writing} />,
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

/** `extra`: what else the answer offers, beside Copy (Save as report). */
function AnswerFooter({ parts, costUsd, at, extra }: { parts: readonly LivePart[]; costUsd?: number; at: string; extra?: ReactNode }) {
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
      {extra && <span className="ms-auto inline-flex">{extra}</span>}
      {text && (
        <button
          type="button"
          onClick={() => void copy()}
          className={cn('inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-semibold hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch:h-10 touch:px-2.5', !extra && 'ms-auto')}
          aria-label="Copy the answer"
        >
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
      )}
    </div>
  )
}

const NO_PARTS: readonly LivePart[] = []

/**
 * An answer: saved (`message`), or being written (`turn`). One component for
 * both, drawn at one key (threadItems), so the hand-over when it is saved
 * keeps its query cards as they were — opened, or showing their table with
 * its filters. `question` is the question it replies to, for its exports and
 * Ask again. `latest`: the conversation's last answer, the one that offers
 * its follow-up questions (`onSuggestion` puts one in the box).
 */
export const Answer = memo(function Answer({
  message,
  turn,
  question,
  onAskAgain,
  latest = false,
  onSuggestion,
  onOpenReport,
}: {
  message?: AiMessage
  turn?: LiveTurn
  question?: string
  onAskAgain?: (q: string) => void
  latest?: boolean
  onSuggestion?: (q: string) => void
  onOpenReport?: (reportId: string) => void
}) {
  const writing = !!turn && isInFlight(turn)
  // The answer as it ended: the saved one, or the turn's once done; until then, the parts as streamed,
  // without the follow-up questions the model is writing at its end (the saved answer has them apart).
  const ended = turn ? (turn.phase === 'done' ? turn.message : null) : (message ?? null)
  const streamed = turn?.parts ?? NO_PARTS
  const parts: readonly LivePart[] = useMemo(() => (ended ? ended.parts : liveDisplayParts(streamed)), [ended, streamed])
  const save = useSaveAsReport(ended, onOpenReport)
  const chips = latest && ended && onSuggestion ? suggestionChips(ended.suggestions) : []
  const last = parts.at(-1)
  // Between queries and before the first word, say what the model is doing. Not a live region: it
  // changes several times a second; the thread's status line says when the phase changes.
  const working = writing && (turn.progress ?? (!last || last.type === 'query' ? (turn.phase === 'sending' ? 'Sending…' : 'Thinking…') : null))
  const retry = ended?.stopReason && ended.stopReason !== 'end_turn' && ended.stopReason !== 'refusal'
  // Each child keeps its place whichever kind of answer this is, so the parts (and their cards) are never redrawn from scratch.
  return (
    <AnswerFrame>
      <AnswerParts parts={parts} question={question} writing={writing} />
      {working && (
        <p dir="auto" className="flex items-center gap-2 text-xs italic text-muted">
          <span aria-hidden className="flex shrink-0 gap-0.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 [animation-delay:300ms]" />
          </span>
          <span className="line-clamp-2">{working}</span>
        </p>
      )}
      {turn?.phase === 'stopped' && <StopNotice reason="stopped" action={<AskAgain question={question} onAskAgain={onAskAgain} />} />}
      {turn?.phase === 'error' && (
        <Notice tone="red" action={<AskAgain question={question} onAskAgain={onAskAgain} />}>
          {turn.error?.message ?? 'The answer could not be finished.'}
        </Notice>
      )}
      {ended && <StopNotice reason={ended.stopReason} notice={ended.notice} action={retry ? <AskAgain question={question} onAskAgain={onAskAgain} /> : undefined} />}
      {ended && <AnswerFooter parts={ended.parts} costUsd={ended.costUsd} at={ended.createdAt} extra={save.button} />}
      {save.notice}
      {chips.length > 0 && onSuggestion && <AiSuggestions questions={chips} onPick={onSuggestion} />}
    </AnswerFrame>
  )
})
