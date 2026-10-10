// ============================================================================
// §20 — the two sides of a conversation. A question is a bubble on the right;
// an answer runs the panel's full width (its tables need it), led by the
// assistant's mark. While it is written it reads in the order it comes — a
// word on what is being checked, the queries as they run, the text with a
// caret — and once it has ended it settles (./answerLayout): its headline
// figures as cards above the text, the charts its queries asked for, and its
// queries folded under "How I got this"; then how it ended, when, Save as
// report and a Copy; the latest answer also offers the questions the model
// suggests asking next. An automation it proposed (§21) is a card in its
// place, to activate, edit or discard; so is a notice it drafted (§23), to
// publish, change, withdraw or delete, or discard. A saved message changes only when it is saved as a
// report, so it is memoised; the answer being written redraws once per frame.
// ============================================================================

import { memo, useId, useMemo, useState, type ReactNode } from 'react'
import { Bot, ChevronRight, Copy, Loader2, RotateCcw } from 'lucide-react'
import type { AiKpi, AiMessage } from '@qc/shared/ai'
import { formatFullTimestamp, formatTime, cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { AiFigure } from './AiFigure'
import { AiKpiCards } from './AiKpiCards'
import { AiMarkdown } from './AiMarkdown'
import { AiQueryCard } from './AiQueryCard'
import { Notice, StopNotice } from './AiNotice'
import { useSaveAsReport } from './AiSaveReport'
import { AiSuggestions } from './AiSuggestions'
import { AutomationProposalCard } from '@/components/automations/AutomationProposalCard'
import { AiNoticeProposalCard } from './AiNoticeProposalCard'
import { answerBlocks, type AnswerBlock } from './answerLayout'
import { queryChart, type ChartModel } from './chartData'
import { kpiCards, liveKpis } from './kpis'
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

type QueryPart = Extract<AnswerBlock, { kind: 'queries' }>['queries'][number]

/**
 * "How I got this": the queries an answer ran, as their cards. Open while the
 * answer is written, so its progress is in view; folded once it has ended,
 * unless the reader opened or closed it themselves. Folded cards stay
 * mounted, so one opened (or its table) keeps its state.
 */
function HowIGotThis({ queries, writing, question }: { queries: readonly QueryPart[]; writing: boolean; question?: string }) {
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? writing
  const id = useId()
  const n = queries.length
  const running = queries.some((q) => q.type === 'pending-query' && q.state === 'running')
  return (
    <section className="pt-0.5">
      <button
        type="button"
        onClick={() => setChosen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex min-h-[28px] items-center gap-1.5 rounded-md pe-1.5 text-xs font-semibold text-muted transition-colors hover:text-slate-700 dark:hover:text-slate-200 touch:min-h-[44px]"
      >
        <ChevronRight aria-hidden className={cn('h-4 w-4 transition-transform duration-200', open ? 'rotate-90' : 'rtl:rotate-180')} />
        How I got this ({n} {n === 1 ? 'query' : 'queries'})
        {running && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-brand-600 dark:text-brand-300" />}
      </button>
      <div id={id} hidden={!open} className="border-s-2 border-slate-200 ps-2.5 dark:border-slate-700">
        {queries.map((q) => (
          <AiQueryCard key={q.queryId} part={q} question={question} writing={writing} />
        ))}
      </div>
    </section>
  )
}

/** "Thinking…", or the model's latest word on what it is doing: three soft dots and a muted line. */
function Working({ text }: { text: string }) {
  return (
    <p dir="auto" className="flex items-center gap-2 text-xs text-muted">
      <span aria-hidden className="ai-dots flex shrink-0 items-center gap-1">
        <span />
        <span />
        <span />
      </span>
      <span className="line-clamp-2">{text}</span>
    </p>
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

/** The answer as markdown for the clipboard: its headline figures as a list, then its text. */
export function answerCopyText(parts: readonly LivePart[], kpis: readonly AiKpi[]): string {
  const figures = kpis.map((k) => `- ${k.label}: ${k.value}`).join('\n')
  return [figures, answerText(parts)].filter(Boolean).join('\n\n')
}

/** `extra`: what else the answer offers, beside Copy (Save as report). No cost: the chat shows no amounts, to anyone. */
function AnswerFooter({ parts, kpis, at, extra }: { parts: readonly LivePart[]; kpis: readonly AiKpi[]; at: string; extra?: ReactNode }) {
  const { toast } = useApp()
  const text = answerCopyText(parts, kpis)
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
const NO_CHARTS: ReadonlyMap<string, ChartModel> = new Map()

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
  // without the blocks the model writes for the app (follow-up questions, headline figures), which the saved answer has apart.
  const ended = turn ? (turn.phase === 'done' ? turn.message : null) : (message ?? null)
  const streamed = turn?.parts ?? NO_PARTS
  const parts: readonly LivePart[] = useMemo(() => (ended ? ended.parts : liveDisplayParts(streamed)), [ended, streamed])
  const kpis = useMemo(() => (ended ? kpiCards(ended.kpis) : liveKpis(streamed)), [ended, streamed])
  // Charts once the answer has ended: drawn while it is written, they would move about under the text still coming.
  const charts = useMemo(() => {
    if (writing) return NO_CHARTS
    const out = new Map<string, ChartModel>()
    for (const p of parts) {
      if (p.type !== 'query') continue
      const model = queryChart(p)
      if (model) out.set(p.queryId, model)
    }
    return out
  }, [parts, writing])
  const blocks = useMemo(() => answerBlocks(parts, { settled: !writing, kpis: kpis.length > 0, charted: new Set(charts.keys()) }), [parts, writing, kpis.length, charts])
  const save = useSaveAsReport(ended, onOpenReport)
  const chips = latest && ended && onSuggestion ? suggestionChips(ended.suggestions) : []
  const last = parts.at(-1)
  // Between queries and before the first word, say what the model is doing: its latest word on it, or "Thinking…".
  // While a query runs, its card says so with its own spinner. Not a live region: it changes several times a
  // second; the thread's status line says when the phase changes.
  const querying = last?.type === 'pending-query' && last.state === 'running'
  const working = writing && (turn.progress ?? (querying || last?.type === 'text' ? null : turn.phase === 'sending' ? 'Sending…' : 'Thinking…'))
  // The caret follows the text as it is written: the last block, while text is what is arriving.
  const caretAt = writing && last?.type === 'text' && !working ? blocks.at(-1)?.key : undefined
  const retry = ended?.stopReason && ended.stopReason !== 'end_turn' && ended.stopReason !== 'refusal'
  const queryOf = (id: string) => parts.find((p): p is Extract<LivePart, { type: 'query' }> => p.type === 'query' && p.queryId === id)
  // Each child keeps its place whichever kind of answer this is, so the parts (and their cards) are never redrawn from scratch.
  return (
    <AnswerFrame>
      {blocks.map((b) => {
        switch (b.kind) {
          case 'text':
            return <AiMarkdown key={b.key} text={b.text} caret={b.key === caretAt} />
          case 'kpis':
            return <AiKpiCards key={b.key} kpis={kpis} />
          case 'figure': {
            const part = queryOf(b.queryId)
            const model = charts.get(b.queryId)
            return part && model ? <AiFigure key={b.key} part={part} model={model} question={question} /> : null
          }
          case 'queries':
            return <HowIGotThis key={b.key} queries={b.queries} writing={writing} question={question} />
          case 'automation':
            return <AutomationProposalCard key={b.key} part={b.part} writing={writing} />
          case 'notice':
            return <AiNoticeProposalCard key={b.key} part={b.part} writing={writing} />
        }
      })}
      {working && <Working text={working} />}
      {turn?.phase === 'stopped' && <StopNotice reason="stopped" action={<AskAgain question={question} onAskAgain={onAskAgain} />} />}
      {turn?.phase === 'error' && (
        <Notice tone="red" action={<AskAgain question={question} onAskAgain={onAskAgain} />}>
          {turn.error?.message ?? 'The answer could not be finished.'}
        </Notice>
      )}
      {ended && <StopNotice reason={ended.stopReason} notice={ended.notice} action={retry ? <AskAgain question={question} onAskAgain={onAskAgain} /> : undefined} />}
      {ended && <AnswerFooter parts={ended.parts} kpis={kpis} at={ended.createdAt} extra={save.button} />}
      {save.notice}
      {chips.length > 0 && onSuggestion && <AiSuggestions questions={chips} onPick={onSuggestion} />}
    </AnswerFrame>
  )
})
