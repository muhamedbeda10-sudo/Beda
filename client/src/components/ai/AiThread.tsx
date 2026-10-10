// ============================================================================
// §20 — one conversation: what was asked and answered, then the answer being
// written. It keeps to the bottom while text streams — unless the reader has
// scrolled up to read, when it stays put and offers a way back down. While a
// conversation loads, the shape of one stands in for it. On the full page
// (`wide`) the thread is a centred column, wide enough for tables and charts.
// ============================================================================

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MessageSquarePlus } from 'lucide-react'
import type { AiMessage } from '@qc/shared/ai'
import { Button, EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAiMessages } from '@/services/queries'
import { useAi, useAiLive } from './AiAssistantProvider'
import { Answer, BotMark, UserBubble } from './AiMessages'
import { Notice } from './AiNotice'
import { answerText, latestAnswerKey, liveAnnouncement, liveView, threadItems } from './liveTurn'
import { noticeCardsWait } from './noticeProposal'
import { AI_STARTER_QUESTIONS } from './suggestions'

const NONE: AiMessage[] = []

export function AiThread({
  onAskAgain,
  onExample,
  onSuggestion,
  onOpenReport,
  wide = false,
}: {
  onAskAgain: (question: string) => void
  onExample: (question: string) => void
  /** A follow-up question tapped under the latest answer: into the box, not sent. */
  onSuggestion: (question: string) => void
  onOpenReport: (reportId: string) => void
  /** The full page: a centred column of at most 1100 px. */
  wide?: boolean
}) {
  const { conversationId, openConversation, enabled } = useAi()
  const live = useAiLive()
  const { data, isLoading, isError, refetch } = useAiMessages(conversationId, enabled)
  const view = liveView(live, conversationId, data?.messages ?? NONE)
  const items = threadItems(live, view)
  // Follow-up questions are offered under the conversation's last answer only: once something is asked after it, they go.
  const latestAnswer = latestAnswerKey(items)
  const empty = conversationId === null && !view.question
  // Read out when the answer on screen changes phase; the turn of another conversation says nothing here.
  const announcement = live && live.conversationId === conversationId ? liveAnnouncement(live) : ''
  // §23 — the answer being written here drafted a notice card: the saved answers' cards wait for it to end.
  const noticesWait = noticeCardsWait(live, conversationId)

  // The question each answer replies to: the user message before it.
  const questions = useMemo(() => {
    const out = new Map<string, string>()
    let asked: string | undefined
    for (const m of view.saved) {
      if (m.role === 'user') asked = answerText(m.parts)
      else if (asked) out.set(m.id, asked)
    }
    return out
  }, [view.saved])

  const scroller = useRef<HTMLDivElement>(null)
  // Kept to the bottom: a ref, read after every draw; the button below follows it as state.
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // Another conversation, or a new question, starts at the bottom.
  useLayoutEffect(() => {
    stick.current = true
    setAtBottom(true)
  }, [conversationId, live?.key])

  // A new chat's welcome reads from the top; a conversation from its end.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && !empty) el.scrollTop = el.scrollHeight
  })

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = near
    if (near !== atBottom) setAtBottom(near)
  }

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      className={cn(
        'relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[radial-gradient(circle_at_1px_1px,rgba(15,23,42,.06)_1px,transparent_0)] [background-size:18px_18px] px-3 py-4 dark:bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,.05)_1px,transparent_0)] sm:px-4',
        wide && 'sm:px-6 lg:px-8 lg:py-6',
      )}
    >
      <div className={cn(wide && 'mx-auto w-full max-w-[1100px]')}>
        {empty && (
          <EmptyState
            icon={<BotMark size="lg" />}
            title="Ask about the factory's record"
            hint="Whatever of the record you were given: inspections, orders and PDI, coils and suppliers, the audit log. Every figure comes from a query shown in the answer, which opens as a table and exports to Excel. The assistant only reads; it changes nothing."
            action={
              <div className={cn('grid w-full gap-2 px-3', wide && 'max-w-3xl sm:grid-cols-2')}>
                {AI_STARTER_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => onExample(q)}
                    dir="auto"
                    className="rounded-xl bg-white px-3 py-2.5 text-start text-13 font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition-colors hover:bg-brand-50 hover:text-brand-800 hover:ring-brand-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-brand-500/15 dark:hover:text-white touch:min-h-[44px]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            }
          />
        )}

        {conversationId !== null && isLoading && <ThreadSkeleton />}
        {conversationId !== null && isError && !data && (
          <Notice
            tone="red"
            action={
              <>
                <Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => void refetch()}>
                  Try again
                </Button>
                <Button className="h-8 min-h-0 px-3 py-0 text-xs" onClick={() => openConversation(null)}>
                  <MessageSquarePlus className="h-3.5 w-3.5" /> New chat
                </Button>
              </>
            }
          >
            This conversation could not be loaded. It may have been deleted.
          </Notice>
        )}

        {/* One keyed list, saved and live alike: an answer keeps its key, and so its cards' state, as it is saved. */}
        <div className="space-y-4">
          {items.map((item) =>
            item.kind === 'saved' ? (
              item.message.role === 'user' ? (
                <UserBubble key={item.key} text={answerText(item.message.parts)} at={item.message.createdAt} />
              ) : (
                <Answer
                  key={item.key}
                  message={item.message}
                  question={questions.get(item.message.id)}
                  onAskAgain={onAskAgain}
                  latest={item.key === latestAnswer}
                  onSuggestion={onSuggestion}
                  onOpenReport={onOpenReport}
                  noticesWait={noticesWait}
                />
              )
            ) : item.kind === 'question' ? (
              <UserBubble key={item.key} text={live!.question} />
            ) : (
              <Answer
                key={item.key}
                turn={live!}
                question={live!.question}
                onAskAgain={onAskAgain}
                latest={item.key === latestAnswer}
                onSuggestion={onSuggestion}
                onOpenReport={onOpenReport}
              />
            ),
          )}
        </div>
      </div>

      {/* Mounted with the thread, so a change is heard; remounted with the conversation, so opening one is not. */}
      <p key={conversationId ?? 'new'} role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {!atBottom && (
        <button
          type="button"
          onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}
          className="sticky bottom-2 left-full grid h-9 w-9 place-items-center rounded-full bg-white text-slate-600 shadow-lift ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
          aria-label="Jump to the latest"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      )}
    </div>
  )
}

/** A conversation on its way: a question and an answer in outline. */
function ThreadSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      <p className="sr-only" role="status">
        Loading the conversation…
      </p>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden className="space-y-4">
          <div className="flex justify-end">
            <div className="skeleton h-9 w-2/5 rounded-2xl rounded-br-md" />
          </div>
          <div className="flex items-start gap-2">
            <span className="skeleton h-7 w-7 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <div className="skeleton h-3.5 w-11/12" />
              <div className="skeleton h-3.5 w-4/5" />
              <div className="skeleton h-3.5 w-3/5" />
              {i === 0 && <div className="skeleton mt-3 h-24 w-full" />}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The open conversation's title (its first question, as the server shortened it). Its own component: it follows the answer being written, the header does not. */
export function AiConversationTitle() {
  const { conversationId, enabled } = useAi()
  const live = useAiLive()
  const { data } = useAiMessages(conversationId, enabled)
  if (conversationId === null) return <>New conversation</>
  return <>{data?.conversation.title ?? (live?.conversationId === conversationId ? live.conversation?.title : undefined) ?? 'Conversation'}</>
}
