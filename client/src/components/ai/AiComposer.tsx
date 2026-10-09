// ============================================================================
// §20 — the question box. Enter sends on a keyboard and Shift+Enter breaks
// the line; on a touch screen Enter breaks the line and the button sends.
// While an answer is written the button stops it. When the assistant cannot
// answer (no key, switched off, the month's budget spent) the box says why.
// ============================================================================

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUp, Square } from 'lucide-react'
import { AI_MAX_MESSAGE_CHARS, type AiStatusResponse } from '@qc/shared/ai'
import { can } from '@qc/shared/rules'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'
import { useAi, useAiLive } from './AiAssistantProvider'
import { UnavailableNotice } from './AiNotice'

const isTouch = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches

export function AiComposer({ value, onChange, status, focusKey }: { value: string; onChange: (v: string) => void; status: AiStatusResponse | undefined; focusKey: number }) {
  const { role } = useAuth()
  const { send, stop, busy, conversationId, openConversation, docked, setOpen } = useAi()
  const live = useAiLive()
  const area = useRef<HTMLTextAreaElement>(null)

  const blocked = status && !status.available ? (status.reason ?? 'reader-unavailable') : null
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

  // Ready to type on opening, on a new chat and on an example — not on a phone, where the keyboard would cover the answer.
  useEffect(() => {
    if (!isTouch()) area.current?.focus()
  }, [focusKey, conversationId])

  const submit = () => {
    if (!canSend) return
    if (send(value)) onChange('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || isTouch()) return
    e.preventDefault()
    submit()
  }

  const settings = blocked && blocked !== 'reader-unavailable' && can(role, 'manage-admin-data') && (
    <Link to="/admin/ai" onClick={() => !docked && setOpen(false)} className="text-xs font-semibold underline underline-offset-2">
      Open the assistant's settings
    </Link>
  )

  return (
    <div className="shrink-0 border-t border-slate-200 bg-white/95 px-3 pb-3 pt-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 safe-bottom">
      {blocked && <UnavailableNotice reason={blocked} action={settings || undefined} />}
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
  )
}
