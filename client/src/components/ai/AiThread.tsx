// ============================================================================
// §20 — one conversation: what was asked and answered, then the answer being
// written. It keeps to the bottom while text streams — unless the reader has
// scrolled up to read, when it stays put and offers a way back down.
// ============================================================================

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, MessageSquarePlus } from 'lucide-react'
import type { AiMessage } from '@qc/shared/ai'
import { Button, EmptyState } from '@/components/ui'
import { useAiMessages } from '@/services/queries'
import { useAi, useAiLive } from './AiAssistantProvider'
import { BotMark, LiveAnswer, SavedMessage, UserBubble } from './AiMessages'
import { Notice } from './AiNotice'
import { answerText, liveView } from './liveTurn'

/** What an administrator might ask first; a tap puts it in the box to send or change. */
const EXAMPLES = [
  'Which five defects cost the most pieces this month, and on which machines?',
  'كام عيب لسه على Hold، وأقدمهم من إمتى؟',
  'Which items had the highest defect rate last month?',
  'كم جلسة فحص أُغلقت الأسبوع الماضي على كل ماكينة؟',
]

const NONE: AiMessage[] = []

export function AiThread({ onAskAgain, onExample }: { onAskAgain: (question: string) => void; onExample: (question: string) => void }) {
  const { conversationId, openConversation, enabled } = useAi()
  const live = useAiLive()
  const { data, isLoading, isError, refetch } = useAiMessages(conversationId, enabled)
  const view = liveView(live, conversationId, data?.messages ?? NONE)
  const empty = conversationId === null && !view.question

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
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[radial-gradient(circle_at_1px_1px,rgba(15,23,42,.06)_1px,transparent_0)] [background-size:18px_18px] px-3 py-4 dark:bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,.05)_1px,transparent_0)] sm:px-4"
    >
      {empty && (
        <EmptyState
          icon={<BotMark size="lg" />}
          title="Ask about the factory's record"
          hint="Inspections, orders and PDI, coils and suppliers, the audit log. Every figure comes from a query shown in the answer, which opens as a table and exports to Excel. The assistant only reads; it changes nothing."
          action={
            <div className="grid w-full gap-2 px-3">
              {EXAMPLES.map((q) => (
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

      {conversationId !== null && isLoading && (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the conversation…
        </p>
      )}
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

      <div className="space-y-4">
        {view.saved.map((m) => (
          <SavedMessage key={m.id} message={m} question={questions.get(m.id)} onAskAgain={onAskAgain} />
        ))}
        {live && view.question && <UserBubble text={live.question} />}
        {live && view.answer && <LiveAnswer turn={live} onAskAgain={onAskAgain} />}
      </div>

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
