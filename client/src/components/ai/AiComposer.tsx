// ============================================================================
// §20 — the question box. Enter sends on a keyboard and Shift+Enter breaks
// the line; on a touch screen Enter breaks the line and the button sends.
// While an answer is written the button stops it: the one this device asked
// and reads, or the one the server is writing in the conversation on screen
// (reopened while it runs, or let go of). When the assistant cannot answer
// the box says so plainly — this month's limit, or "not available" — and
// only its owner is offered the settings, where the precise reason is.
//
// Files go with a question: the paperclip, the scanner (a photo of a paper
// sheet, the camera on a phone), a photo pasted into the box, or files
// dropped on it. Each shows as a chip while it uploads, and the question
// waits until every one is kept (or taken off).
//
// Above the box the person picks how deep the question is answered (Quick,
// Standard, Deep); the sparkles open what the assistant can do. The box sits
// in a ring of light that turns, faster while an answer is written.
// ============================================================================

import { forwardRef, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, ArrowUp, FileSpreadsheet, FileText, Gauge, Image as ImageIcon, Loader2, Paperclip, Rocket, ScanLine, Sparkles, Square, X, Zap, type LucideIcon } from 'lucide-react'
import { AI_DEPTHS, AI_MAX_MESSAGE_CHARS, type AiAttachmentKind, type AiDepth } from '@qc/shared/ai'
import { FloatingPanel } from '@/components/dashboard/filters'
import { isCoarsePointer } from '@/lib/media'
import { cn } from '@/lib/utils'
import { aiConversationGone, useAiMe, useAiMessages } from '@/services/queries'
import { aiBlock } from './access'
import { useAi, useAiLive } from './AiAssistantProvider'
import { AiCapabilityMenu } from './AiCapabilities'
import { formatBytes, readyIds, type PendingAttachment } from './attachments'
import { AiFileInput } from './AiFileInput'
import { AI_CAPABILITIES, type AiCapability } from './capabilities'
import { BlockedNotice } from './AiNotice'
import { letGoOf } from './liveTurn'
import { spentFocus, takesCaret, withPicked, type ComposerFocus } from './suggestions'
import { useTakeFiles } from './useTakeFiles'

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
  const { send, stop, stopConversation, busy, conversationId, openConversation, attachments, detach, enabled, depth, setDepth } = useAi()
  const live = useAiLive()
  const { data: me } = useAiMe()
  const { data: thread, error: threadError } = useAiMessages(conversationId, enabled)
  const { take, room, noRoom } = useTakeFiles()
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const scanner = useRef<HTMLInputElement>(null)
  const sparkles = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
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
  const answering = readingHere || runningHere
  const canAttach = !blocked && room > 0

  /** The caret after the text, unless on a touch screen, where the keyboard would cover the answer. */
  const caretLater = () =>
    requestAnimationFrame(() => {
      if (area.current && !isCoarsePointer()) caretAtEnd(area.current)
    })

  /** A card from the sparkles: its question into the box (after what was typed), and a paper sheet's camera opened now. */
  const pick = (c: AiCapability) => {
    setMenu(false)
    onChange(withPicked(value, c.question))
    if (c.photo && !blocked) {
      if (canAttach) scanner.current?.click()
      else noRoom()
    }
    caretLater()
  }

  /** The scanner: a photo of a paper sheet (the camera, on a phone), with the paper-sheet question when the box is empty. */
  const scan = () => {
    const sheet = AI_CAPABILITIES.find((c) => c.id === 'scan')!
    if (!value.trim()) onChange(sheet.question)
    scanner.current?.click()
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
      )}
    >
      <div className={cn(wide && 'mx-auto w-full max-w-[1100px]')}>
        {blocked && (
          <div className="mb-2">
            <BlockedNotice reason={blocked} action={settings || undefined} />
          </div>
        )}
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
        <div className="mb-1.5 flex justify-end">
          <DepthSwitch value={depth} onChange={setDepth} disabled={!!blocked} />
        </div>
        <AiFileInput ref={picker} kind="files" />
        {/* A phone opens its camera on the sheet; a computer, its files. */}
        <AiFileInput ref={scanner} kind="sheet" />
        <div className="ai-frame" data-busy={answering}>
          <div className={cn('rounded-[12.5px]', dragging ? 'bg-brand-50 dark:bg-brand-950' : 'bg-white dark:bg-slate-900')}>
            {attachments.length > 0 && (
              <ul className="flex gap-1.5 overflow-x-auto px-2 pt-2 sm:flex-wrap sm:overflow-visible" aria-label="Files attached to the question">
                {attachments.map((a) => (
                  <AttachmentChip key={a.key} file={a} onRemove={() => detach(a.key)} />
                ))}
              </ul>
            )}
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
              className="block min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-snug text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
              <div className="flex items-center gap-0.5">
                <ToolButton
                  ref={sparkles}
                  icon={Sparkles}
                  label="What it can do"
                  onClick={() => setMenu((m) => !m)}
                  disabled={!!blocked}
                  active={menu}
                  tone="emerald"
                  aria-haspopup="menu"
                  aria-expanded={menu}
                />
                <ToolButton icon={Paperclip} label="Attach a photo, PDF or spreadsheet" onClick={() => picker.current?.click()} disabled={!canAttach} />
                <ToolButton icon={ScanLine} label="Scan a paper sheet" onClick={scan} disabled={!canAttach} />
              </div>
              {answering ? (
                <button
                  type="button"
                  onClick={stopHere}
                  disabled={stopping}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-100 text-rose-700 ring-1 ring-rose-300 transition hover:bg-rose-200 disabled:opacity-40 dark:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-500/40 dark:hover:bg-rose-500/30 touch:h-11 touch:w-11"
                  aria-label={stopping ? 'Stopping the answer' : 'Stop the answer'}
                  data-tip={stopping ? 'Stopping…' : 'Stop'}
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSend}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-700 text-white shadow-card transition hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800 dark:disabled:text-slate-500 touch:h-11 touch:w-11"
                  aria-label="Send"
                  data-tip="Send"
                >
                  <ArrowUp className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>
        </div>
        <FloatingPanel anchor={sparkles} open={menu} onClose={() => setMenu(false)} width={300} label="What it can do">
          <AiCapabilityMenu onPick={pick} />
        </FloatingPanel>
        {value.length > AI_MAX_MESSAGE_CHARS - 500 && (
          <p className={cn('mt-1 text-end text-[11px] tabular-nums', value.length >= AI_MAX_MESSAGE_CHARS ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-muted')}>
            {value.length.toLocaleString()} / {AI_MAX_MESSAGE_CHARS.toLocaleString()}
          </p>
        )}
      </div>
    </div>
  )
}

const DEPTH_ICON: Record<AiDepth, LucideIcon> = { quick: Zap, standard: Gauge, deep: Rocket }

/** Quick, Standard, Deep: how deep the next question is answered (AI_DEPTHS), one picked at a time. */
function DepthSwitch({ value, onChange, disabled }: { value: AiDepth; onChange: (depth: AiDepth) => void; disabled: boolean }) {
  return (
    <div role="radiogroup" aria-label="How deep to answer" className="inline-flex items-center gap-0.5 rounded-lg bg-white p-0.5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
      {AI_DEPTHS.map((d) => {
        const Icon = DEPTH_ICON[d.id]
        const on = d.id === value
        return (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(d.id)}
            data-tip={d.note}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold transition disabled:opacity-50 touch:h-9 touch:px-2.5',
              on ? 'bg-emerald-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white',
            )}
          >
            <Icon aria-hidden className="h-3.5 w-3.5" />
            {d.name}
          </button>
        )
      })}
    </div>
  )
}

/** A small round button on the box's lower edge. */
const ToolButton = forwardRef<
  HTMLButtonElement,
  { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean; active?: boolean; tone?: 'emerald' } & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-haspopup' | 'aria-expanded'>
>(function ToolButton({ icon: Icon, label, onClick, disabled, active, tone, ...aria }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-tip={label}
      {...aria}
      className={cn(
        'grid h-8 w-8 place-items-center rounded-lg transition hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800 touch:h-11 touch:w-11',
        tone === 'emerald'
          ? 'text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300'
          : 'text-slate-500 hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300',
        active && 'bg-slate-100 dark:bg-slate-800',
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  )
})

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
