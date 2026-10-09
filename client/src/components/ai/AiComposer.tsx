// ============================================================================
// §20 — the question box. Enter sends on a keyboard and Shift+Enter breaks
// the line; on a touch screen Enter breaks the line and the button sends.
// While an answer is written the button stops it. When the assistant cannot
// answer the box says so plainly — this month's limit, or "not available" —
// and only its owner is offered the settings, where the precise reason is.
// ============================================================================

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUp, Square } from 'lucide-react'
import { AI_MAX_MESSAGE_CHARS } from '@qc/shared/ai'
import { cn } from '@/lib/utils'
import { useAiMe } from '@/services/queries'
import { aiBlock } from './access'
import { useAi, useAiLive } from './AiAssistantProvider'
import { BlockedNotice } from './AiNotice'
import { spentFocus, takesCaret, type ComposerFocus } from './suggestions'

const isTouch = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches

function caretAtEnd(el: HTMLTextAreaElement) {
  el.focus()
  const end = el.value.length
  el.setSelectionRange(end, end)
}

/**
 * The question box's state for a surface (the panel or the full page): the
 * unsent text — kept in the provider's ref too, so it survives the surface
 * closing and follows Expand and Dock — and the requests to put the caret in
 * it. `focusComposer(always)`: see ComposerFocus.
 */
export function useComposerDraft() {
  const { draft: kept } = useAi()
  const [draft, setDraftState] = useState(() => kept.current)
  const [focus, setFocus] = useState<ComposerFocus>({ key: 0, always: false })
  const setDraft = useCallback(
    (value: string) => {
      kept.current = value
      setDraftState(value)
    },
    [kept],
  )
  const focusComposer = useCallback((always: boolean) => setFocus((f) => ({ key: f.key + 1, always })), [])
  const focusUsed = useCallback(() => setFocus(spentFocus), [])
  return { draft, setDraft, focus, focusComposer, focusUsed }
}

export function AiComposer({
  value,
  onChange,
  focus,
  onFocusUsed,
  wide = false,
}: {
  value: string
  onChange: (v: string) => void
  focus: ComposerFocus
  /** The request was acted on: its `always` is spent (see spentFocus). */
  onFocusUsed: () => void
  /** The full page: the box keeps to the thread's centred column. */
  wide?: boolean
}) {
  const { send, stop, busy, conversationId, openConversation, docked, setOpen } = useAi()
  const live = useAiLive()
  const { data: me } = useAiMe()
  const area = useRef<HTMLTextAreaElement>(null)

  const blocked = aiBlock(me)
  // One answer at a time: one being written in another conversation holds this box too.
  const elsewhere = busy && !!live && live.conversationId !== conversationId
  const canSend = !busy && !blocked && value.trim().length > 0

  // Grows with the text up to 160 px, then scrolls.
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }, [value])

  // Ready to type on opening, on a new chat and on an example — not on a phone, where the keyboard would cover the
  // answer, unless a follow-up question was tapped to be finished there. The caret goes after what was put in. Each
  // request is acted on once here (`handled`), and its `always` is spent then: coming back to the thread later
  // mounts the box again, and must not raise a phone's keyboard over the answer.
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (handled.current === focus.key) return
    handled.current = focus.key
    const el = area.current
    if (el && takesCaret(focus, isTouch())) caretAtEnd(el)
    if (focus.always) onFocusUsed()
  }, [focus, onFocusUsed])
  useEffect(() => {
    const el = area.current
    if (el && !isTouch()) caretAtEnd(el)
  }, [conversationId])

  const submit = () => {
    if (!canSend) return
    if (send(value)) onChange('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || isTouch()) return
    e.preventDefault()
    submit()
  }

  // The owner alone has somewhere to go about it: the settings page says precisely why, and holds the switch, the key and the caps.
  const settings = blocked && me?.owner && (
    <Link to="/admin/ai" onClick={() => !docked && setOpen(false)} className="text-xs font-semibold underline underline-offset-2">
      Open the assistant's settings
    </Link>
  )

  return (
    <div className={cn('shrink-0 border-t border-slate-200 bg-white/95 px-3 pb-3 pt-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 safe-bottom', wide && 'sm:px-6 lg:px-8 lg:pb-4 lg:pt-3')}>
      <div className={cn(wide && 'mx-auto w-full max-w-[1100px]')}>
        {blocked && <BlockedNotice reason={blocked} action={settings || undefined} />}
        {elsewhere && (
          <p className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            Still answering in another conversation.
            <button type="button" onClick={() => openConversation(live?.conversationId ?? null)} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
              Go to it
            </button>
            <button type="button" onClick={stop} className="font-semibold text-rose-700 hover:underline dark:text-rose-300">
              Stop it
            </button>
          </p>
        )}
        <div className={cn('flex items-end gap-2', blocked && 'mt-2')}>
          <textarea
            ref={area}
            value={value}
            rows={1}
            dir="auto"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={AI_MAX_MESSAGE_CHARS}
            disabled={!!blocked}
            placeholder={blocked ? 'The assistant cannot answer right now' : 'Ask about inspections, orders, coils…'}
            aria-label="Your question"
            className="input min-h-[44px] flex-1 resize-none rounded-2xl py-2.5 leading-snug disabled:cursor-not-allowed disabled:opacity-60"
          />
          {busy && !elsewhere ? (
            <button type="button" onClick={stop} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-800 text-white shadow-card transition hover:bg-slate-900 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white" aria-label="Stop the answer" data-tip="Stop">
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button type="button" onClick={submit} disabled={!canSend} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-600 text-white shadow-card transition hover:bg-brand-700 disabled:opacity-40" aria-label="Send" data-tip="Send">
              <ArrowUp className="h-5 w-5" />
            </button>
          )}
        </div>
        {value.length > AI_MAX_MESSAGE_CHARS - 500 && (
          <p className={cn('mt-1 text-end text-[11px] tabular-nums', value.length >= AI_MAX_MESSAGE_CHARS ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-muted')}>
            {value.length.toLocaleString()} / {AI_MAX_MESSAGE_CHARS.toLocaleString()}
          </p>
        )}
      </div>
    </div>
  )
}
