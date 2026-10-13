// ============================================================================
// §20 — the question box. Enter sends on a keyboard and Shift+Enter breaks
// the line; on a touch screen Enter breaks the line and the button sends.
// While an answer is written the button stops it: the one this device asked
// and reads, or the one the server is writing in the conversation on screen
// (reopened while it runs, or let go of). When the assistant cannot answer
// the box says so plainly — this month's limit, or "not available" — and
// only its owner is offered the settings, where the precise reason is.
//
// Files go with a question: the paperclip, a photo pasted into the box, or
// files dropped on it. Each shows as a chip while it uploads, and the
// question waits until every one is kept (or taken off).
// ============================================================================

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, ArrowUp, FileSpreadsheet, FileText, Image as ImageIcon, Loader2, Paperclip, Square, X } from 'lucide-react'
import { AI_MAX_ATTACHMENTS_PER_QUESTION, AI_MAX_MESSAGE_CHARS, type AiAttachmentKind } from '@qc/shared/ai'
import { isCoarsePointer } from '@/lib/media'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/AppContext'
import { aiConversationGone, useAiMe, useAiMessages } from '@/services/queries'
import { aiBlock } from './access'
import { useAi, useAiLive } from './AiAssistantProvider'
import { ATTACH_ACCEPT, formatBytes, readyIds, type PendingAttachment } from './attachments'
import { BlockedNotice } from './AiNotice'
import { letGoOf } from './liveTurn'
import { spentFocus, takesCaret, type ComposerFocus } from './suggestions'

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
 *
 * A new conversation composed elsewhere (§21, "Edit in chat": the provider's
 * compose) reaches a box already on screen too: it takes the text with the
 * caret, and `onComposed` lets the surface show the conversation. A surface
 * that opens afterwards starts from the kept text anyway.
 */
export function useComposerDraft(onComposed?: () => void) {
  const { draft: kept, composed } = useAi()
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
  // What was composed before this surface opened is in the kept text already; only a later one is taken here.
  const seen = useRef(composed)
  const onComposedRef = useRef(onComposed)
  onComposedRef.current = onComposed
  useEffect(() => {
    if (seen.current === composed) return
    seen.current = composed
    setDraftState(kept.current)
    focusComposer(true)
    onComposedRef.current?.()
  }, [composed, kept, focusComposer])
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
  const { send, stop, stopConversation, busy, conversationId, openConversation, attachments, attach, detach, enabled } = useAi()
  const live = useAiLive()
  const { data: me } = useAiMe()
  const { data: thread, error: threadError } = useAiMessages(conversationId, enabled)
  const { toast } = useApp()
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const blocked = aiBlock(me)
  // One answer at a time: one being written in another conversation holds this box too.
  const elsewhere = busy && !!live && live.conversationId !== conversationId
  // The answer this device reads is in the conversation on screen; else the server is writing one there, as the
  // conversation says, or as a stream this device let go of left it until the conversation is fetched again.
  const readingHere = busy && !elsewhere
  // Deleted elsewhere (or the assistant taken away): nothing runs there to stop.
  const gone = aiConversationGone(threadError)
  const running = gone ? null : (thread?.running ?? null)
  const runningHere = !readingHere && !gone && (running !== null || letGoOf(live, conversationId, thread?.messages ?? []))
  // Stop pressed already: the answer ends at its next step.
  const stopping = running && !readingHere ? running.stopping : !!live?.stopping
  const filesReady = readyIds(attachments) !== null
  const canSend = !busy && !runningHere && !blocked && filesReady && (value.trim().length > 0 || attachments.length > 0)
  const room = AI_MAX_ATTACHMENTS_PER_QUESTION - attachments.length

  /** Attach what was picked, pasted or dropped, as many as the question has room for; says what it could not take. */
  const take = (files: readonly File[]) => {
    if (files.length === 0 || blocked) return
    if (room <= 0) {
      toast(`A question may carry at most ${AI_MAX_ATTACHMENTS_PER_QUESTION} files.`, 'warning')
      return
    }
    const refused = attach(files.slice(0, room))
    if (files.length > room) toast(`A question may carry at most ${AI_MAX_ATTACHMENTS_PER_QUESTION} files: the rest were left out.`, 'warning')
    if (refused.length > 0) toast(`Only photos, PDFs and spreadsheets (.xlsx, .csv) can be attached: ${refused.join(', ')}.`, 'error')
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    take(files)
  }
  const onDragOver = (e: DragEvent) => {
    if (blocked || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }
  const onDrop = (e: DragEvent) => {
    setDragging(false)
    if (blocked || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    take(Array.from(e.dataTransfer.files))
  }

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
    if (el && takesCaret(focus, isCoarsePointer())) caretAtEnd(el)
    if (focus.always) onFocusUsed()
  }, [focus, onFocusUsed])
  useEffect(() => {
    const el = area.current
    if (el && !isCoarsePointer()) caretAtEnd(el)
  }, [conversationId])

  const submit = () => {
    if (!canSend) return
    if (send(value)) onChange('')
  }
  const stopHere = () => {
    if (readingHere) stop()
    else if (conversationId) stopConversation(conversationId)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || isCoarsePointer()) return
    e.preventDefault()
    submit()
  }

  // The owner alone has somewhere to go about it: the settings page says precisely why, and holds the switch, the key and the caps.
  const settings = blocked && me?.owner && (
    <Link to="/admin/ai" className="inline-flex items-center text-xs font-semibold underline underline-offset-2 touch:min-h-[44px]">
      Open the assistant's settings
    </Link>
  )

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'shrink-0 border-t border-slate-200 bg-white/95 px-3 pb-3 pt-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 safe-bottom',
        wide && 'sm:px-6 lg:px-8 lg:pb-4 lg:pt-3',
        dragging && 'bg-brand-50/95 ring-2 ring-inset ring-brand-400 dark:bg-brand-950/60',
      )}
    >
      <div className={cn(wide && 'mx-auto w-full max-w-[1100px]')}>
        {blocked && <BlockedNotice reason={blocked} action={settings || undefined} />}
        {elsewhere && (
          <p className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            Still answering in another conversation.
            <button type="button" onClick={() => openConversation(live?.conversationId ?? null)} className="font-semibold text-brand-700 hover:underline dark:text-brand-300 touch:min-h-[44px] touch:px-1">
              Go to it
            </button>
            <button type="button" onClick={stop} className="font-semibold text-rose-700 hover:underline dark:text-rose-300 touch:min-h-[44px] touch:px-1">
              Stop it
            </button>
          </p>
        )}
        {attachments.length > 0 && (
          <ul className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-0.5 sm:flex-wrap sm:overflow-visible" aria-label="Files attached to the question">
            {attachments.map((a) => (
              <AttachmentChip key={a.key} file={a} onRemove={() => detach(a.key)} />
            ))}
          </ul>
        )}
        <div className={cn('flex items-end gap-2', blocked && 'mt-2')}>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            className="hidden"
            onChange={(e) => {
              take(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={!!blocked || room <= 0}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-brand-700 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-brand-300"
            aria-label="Attach photos, PDFs or spreadsheets"
            data-tip="Attach a photo, PDF or spreadsheet"
          >
            <Paperclip className="h-5 w-5" />
          </button>
          <textarea
            ref={area}
            value={value}
            rows={1}
            dir="auto"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            maxLength={AI_MAX_MESSAGE_CHARS}
            disabled={!!blocked}
            placeholder={blocked ? 'The assistant cannot answer right now' : attachments.length > 0 ? 'Ask about the attached files…' : 'Ask about inspections, orders, coils…'}
            aria-label="Your question"
            className="input min-h-[44px] flex-1 resize-none rounded-2xl py-2.5 leading-snug disabled:cursor-not-allowed disabled:opacity-60"
          />
          {readingHere || runningHere ? (
            <button
              type="button"
              onClick={stopHere}
              disabled={stopping}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-800 text-white shadow-card transition hover:bg-slate-900 disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
              aria-label={stopping ? 'Stopping the answer' : 'Stop the answer'}
              data-tip={stopping ? 'Stopping…' : 'Stop'}
            >
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

const KIND_ICON: Record<AiAttachmentKind, typeof ImageIcon> = { image: ImageIcon, pdf: FileText, sheet: FileSpreadsheet }

/** A file on the question: uploading, kept (with its size or outline) or failed (with why), and a way to take it off. */
function AttachmentChip({ file, onRemove }: { file: PendingAttachment; onRemove: () => void }) {
  const Icon = KIND_ICON[file.kind]
  const detail = file.state === 'failed' ? file.error : file.state === 'uploading' ? 'Attaching…' : file.attachment?.summary ?? (file.attachment ? formatBytes(file.attachment.byteSize) : '')
  const thumb = file.attachment?.thumbnailDataUrl
  return (
    <li
      className={cn(
        'flex max-w-full shrink-0 items-center gap-2 rounded-xl border py-1 pe-1 ps-1.5 text-xs',
        file.state === 'failed'
          ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200'
          : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
      )}
      title={file.state === 'failed' ? file.error : file.name}
    >
      {thumb ? (
        <img src={thumb} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white text-slate-500 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700">
          {file.state === 'uploading' ? <Loader2 className="h-4 w-4 animate-spin" /> : file.state === 'failed' ? <AlertCircle className="h-4 w-4 text-rose-600" /> : <Icon className="h-4 w-4" />}
        </span>
      )}
      <span className="min-w-0">
        <span dir="auto" className="block max-w-[8rem] truncate font-medium sm:max-w-[11rem]">
          {file.name}
        </span>
        {detail && <span className={cn('block max-w-[10rem] truncate text-[11px] sm:max-w-[14rem]', file.state === 'failed' ? '' : 'text-muted')}>{detail}</span>}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-100 touch:h-10 touch:w-10"
        aria-label={`Remove ${file.name}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}
