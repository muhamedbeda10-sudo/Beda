// ============================================================================
// The message box: text with @ and # completion, emoji, photos and files,
// a reply banner, and an edit mode. Enter sends on a keyboard; on a touch
// screen Enter breaks the line and the button sends.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, FileUp, ImagePlus, Loader2, Paperclip, Pencil, Send, Smile, X } from 'lucide-react'
import { CHAT_FILE_ATTACHMENTS_ENABLED, type ChatMentionKind, type ChatMessage, type StoredFile } from '@qc/shared/types'
import { isStockOrder } from '@qc/shared/rules'
import { useImages, useChatUsers, useMaster, useOpenBoard, useOrderSearch } from '@/services/queries'
import { uploadChatFile } from '@/services/mutations'
import { uploadImage } from '@/services/uploadImage'
import { ImageRejected } from '@/services/imageStore'
import { useApp } from '@/store/AppContext'
import { ApiError } from '@/lib/api'
import { isCoarsePointer } from '@/lib/media'
import { cn, newSubmissionId } from '@/lib/utils'
import { EmojiPicker } from './EmojiPicker'
import { mentionToken, plainText, triggerAt } from './mentions'

interface Suggestion {
  kind: ChatMentionKind
  value: string
  label: string
  sub?: string
}

export function Composer({
  conversationId,
  replyTo,
  onCancelReply,
  editing,
  onCancelEdit,
  onSend,
  onSaveEdit,
}: {
  conversationId: string
  replyTo: ChatMessage | null
  onCancelReply: () => void
  editing: ChatMessage | null
  onCancelEdit: () => void
  onSend: (body: string, imageIds: string[], fileIds: string[], clientId: string) => Promise<void>
  onSaveEdit: (body: string) => Promise<void>
}) {
  const { toast } = useApp()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [imageIds, setImageIds] = useState<string[]>([])
  const [files, setFiles] = useState<StoredFile[]>([])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [emoji, setEmoji] = useState(false)
  const [pick, setPick] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const emojiButton = useRef<HTMLButtonElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const clientId = useRef(newSubmissionId())
  const { data: attached = [] } = useImages(imageIds)

  // Switching conversation or entering edit mode resets the box. The caret goes into it — on a touch screen only for
  // an edit, which was asked for: opening a conversation does not raise the keyboard over its messages.
  useEffect(() => {
    setText(editing?.body ?? '')
    setImageIds([])
    setFiles([])
    clientId.current = newSubmissionId()
    if (editing || !isCoarsePointer()) area.current?.focus()
  }, [conversationId, editing])

  useEffect(() => {
    if (replyTo) area.current?.focus()
  }, [replyTo])

  // Autosize.
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }, [text])

  const trigger = useMemo(() => triggerAt(text, caret), [text, caret])
  const { data: users = [] } = useChatUsers(!!trigger && trigger.sigil === '@')
  const { data: machines = [] } = useMaster('machines', undefined, !!trigger && trigger.sigil === '#')
  // Order lines are searched by prefix from the first character: an order number, an item code or a line key.
  const { data: orders = [] } = useOrderSearch(trigger?.sigil === '#' ? trigger.query : '', 20, !!trigger && trigger.sigil === '#' && trigger.query.length >= 1)
  const { data: board } = useOpenBoard()

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger) return []
    const q = trigger.query.toLowerCase()
    if (trigger.sigil === '@') {
      return users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)).slice(0, 8).map((u) => ({ kind: 'user', value: u.id, label: u.name, sub: u.username }))
    }
    // Orders first: that is what the floor points at most. Then the items of
    // those orders, the open sessions, and the machines whose code starts
    // with what was typed (a bare "#" lists the machines and open sessions).
    const out: Suggestion[] = []
    const items = new Map<string, string>()
    for (const o of orders.slice(0, 8)) {
      if (isStockOrder(o)) continue
      out.push({ kind: 'order', value: o.id, label: `${o.orderNumber} · ${o.item} · ${o.workCenterCode}`, sub: `Order line · ${o.itemCode}` })
      if (!items.has(o.itemCode.toLowerCase())) items.set(o.itemCode.toLowerCase(), o.item)
    }
    for (const [code, item] of items) {
      const o = orders.find((x) => x.itemCode.toLowerCase() === code)
      if (o) out.push({ kind: 'item', value: o.itemCode, label: `${o.itemCode} · ${item}`, sub: 'Item' })
    }
    for (const s of board?.sessions ?? []) {
      const label = `${s.order?.orderNumber ?? 'STOCK'} · ${s.order?.itemCode ?? ''} · ${s.workCenterCode} #${s.seq}`
      if (!q || label.toLowerCase().includes(q)) out.push({ kind: 'session', value: s.id, label, sub: `Session · ${s.inspectorName}` })
    }
    for (const m of machines) {
      if (!q || m.code.toLowerCase().startsWith(q) || m.displayName.toLowerCase().includes(q)) out.push({ kind: 'machine', value: m.code, label: m.displayName, sub: 'Machine' })
    }
    return out.slice(0, 12)
  }, [trigger, users, machines, orders, board])

  useEffect(() => setPick(0), [suggestions.length, trigger?.query])

  const insertAt = (start: number, end: number, insert: string) => {
    const next = `${text.slice(0, start)}${insert}${text.slice(end)}`
    setText(next)
    const pos = start + insert.length
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  const choose = (s: Suggestion) => {
    if (!trigger) return
    const shortLabel = s.kind === 'machine' ? s.value : s.kind === 'user' ? s.label : s.label.split(' · ').slice(0, 2).join(' · ')
    insertAt(trigger.start, caret, `${mentionToken(s.kind, s.value, shortLabel)} `)
  }

  const addEmoji = (e: string) => {
    const el = area.current
    const pos = el ? el.selectionStart : text.length
    insertAt(pos, el ? el.selectionEnd : pos, e)
    setEmoji(false)
  }

  const pickImages = async (list: FileList | null) => {
    if (!list) return
    for (const f of Array.from(list).slice(0, 10 - imageIds.length)) {
      setUploading((n) => n + 1)
      try {
        const asset = await uploadImage(f, {})
        setImageIds((ids) => [...ids, asset.id])
      } catch (e) {
        toast(e instanceof ImageRejected || e instanceof ApiError ? e.message : 'The photo could not be uploaded.', 'error')
      } finally {
        setUploading((n) => n - 1)
      }
    }
    if (imgRef.current) imgRef.current.value = ''
  }

  const pickFile = async (f: File | undefined) => {
    if (!CHAT_FILE_ATTACHMENTS_ENABLED) return
    if (!f) return
    if (f.size > 25 * 1024 * 1024) {
      toast('A file may be at most 25 MB.', 'error')
      return
    }
    setUploading((n) => n + 1)
    try {
      const stored = await uploadChatFile(f)
      setFiles((fs) => [...fs, stored])
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The file could not be uploaded.', 'error')
    } finally {
      setUploading((n) => n - 1)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const canSend = !busy && uploading === 0 && (text.trim().length > 0 || imageIds.length > 0 || files.length > 0)

  const submit = async () => {
    if (!canSend) return
    setBusy(true)
    try {
      if (editing) {
        await onSaveEdit(text.trim())
      } else {
        await onSend(text.trim(), imageIds, files.map((f) => f.id), clientId.current)
        clientId.current = newSubmissionId()
      }
      setText('')
      setImageIds([])
      setFiles([])
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0 && trigger) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => (p + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => (p - 1 + suggestions.length) % suggestions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(suggestions[pick]); return }
      if (e.key === 'Escape') { e.preventDefault(); insertAt(caret, caret, ' '); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer()) {
      e.preventDefault()
      void submit()
    }
    if (e.key === 'Escape' && editing) onCancelEdit()
  }

  return (
    <div className="relative border-t border-slate-200 bg-white/95 px-2 pb-2 pt-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 safe-bottom">
      {(replyTo || editing) && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border-l-4 border-brand-500 bg-slate-50 px-3 py-1.5 text-xs dark:bg-slate-800">
          {editing ? <Pencil className="mt-0.5 h-3.5 w-3.5 text-brand-600" /> : <span className="mt-0.5 font-bold text-brand-700 dark:text-brand-300">{replyTo?.senderName}</span>}
          <span className="line-clamp-2 flex-1 text-slate-600 dark:text-slate-300">{editing ? 'Editing your message' : plainText(replyTo?.body ?? '') || (replyTo?.imageIds.length ? '📷 Photo' : '📎 File')}</span>
          {/* 36 px (44 with a finger), its margins taken back so the banner keeps its height. */}
          <button type="button" onClick={editing ? onCancelEdit : onCancelReply} className="icon-btn -my-1.5 -me-2 h-9 w-9 shrink-0 touch:h-11 touch:w-11" aria-label={editing ? 'Cancel the edit' : 'Cancel the reply'}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {(attached.length > 0 || files.length > 0 || uploading > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {attached.map((a) => (
            <span key={a.id} className="relative">
              <img src={a.thumbnailDataUrl} alt="" className="h-14 w-14 rounded-lg object-cover ring-1 ring-slate-200 dark:ring-slate-700" />
              {/* A 24 px circle on the photo's corner; its target reaches 40 px around it (44 with a finger). */}
              <button
                type="button"
                onClick={() => setImageIds((ids) => ids.filter((x) => x !== a.id))}
                className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-slate-900 text-white ring-2 ring-white before:absolute before:-inset-2 touch:before:-inset-2.5 dark:ring-slate-900"
                aria-label="Remove photo"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {files.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium dark:bg-slate-800">
              <Paperclip className="h-3.5 w-3.5" /> {f.originalFilename}
              <button
                type="button"
                onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))}
                className="relative -my-1 -me-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:text-rose-600 before:absolute before:-inset-2 touch:before:-inset-2.5"
                aria-label={`Remove ${f.originalFilename}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…
            </span>
          )}
        </div>
      )}
      {suggestions.length > 0 && (
        <ul className="absolute bottom-full left-2 right-2 z-30 mb-1 max-h-64 overflow-y-auto rounded-2xl bg-white p-1 shadow-lift ring-1 ring-slate-200 animate-scale-in dark:bg-slate-900 dark:ring-slate-700" role="listbox">
          {suggestions.map((s, i) => (
            <li key={`${s.kind}:${s.value}`}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(s)} className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm', i === pick ? 'bg-brand-50 dark:bg-brand-500/15' : 'hover:bg-slate-50 dark:hover:bg-slate-800')} role="option" aria-selected={i === pick}>
                <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-bold', s.kind === 'user' ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-100' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100')}>
                  {s.kind === 'user' ? <AtSign className="h-3.5 w-3.5" /> : '#'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{s.label}</span>
                  {s.sub && <span className="block truncate text-xs text-muted">{s.sub}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {emoji && <EmojiPicker onPick={addEmoji} onClose={() => setEmoji(false)} trigger={emojiButton} className="absolute bottom-full left-2 mb-1" />}
      <div className="flex items-end gap-1">
        <button ref={emojiButton} type="button" onClick={() => setEmoji((v) => !v)} className="icon-btn h-10 w-10 touch:h-11 touch:w-11" aria-label="Emoji" aria-expanded={emoji}>
          <Smile className="h-5 w-5" />
        </button>
        {!editing && (
          <>
            <button type="button" onClick={() => imgRef.current?.click()} className="icon-btn h-10 w-10 touch:h-11 touch:w-11" aria-label="Photo" disabled={imageIds.length >= 10}>
              <ImagePlus className="h-5 w-5" />
            </button>
            {CHAT_FILE_ATTACHMENTS_ENABLED && (
              <button type="button" onClick={() => fileRef.current?.click()} className="icon-btn hidden h-10 w-10 sm:grid" aria-label="File" disabled={files.length >= 5}>
                <FileUp className="h-5 w-5" />
              </button>
            )}
            <input ref={imgRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void pickImages(e.target.files)} />
            {CHAT_FILE_ATTACHMENTS_ENABLED && <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xls,application/pdf" className="hidden" onChange={(e) => void pickFile(e.target.files?.[0])} />}
          </>
        )}
        <textarea
          ref={area}
          value={text}
          rows={1}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart) }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKey}
          placeholder={editing ? 'Edit your message' : 'Message · @ person · # order, item, machine'}
          className="input min-h-[40px] flex-1 resize-none rounded-2xl py-2 leading-snug touch:min-h-[44px]"
          maxLength={4000}
          aria-label="Message"
        />
        <button type="button" onClick={() => void submit()} disabled={!canSend} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white shadow-card transition hover:bg-brand-700 disabled:opacity-40 touch:h-11 touch:w-11" aria-label={editing ? 'Save' : 'Send'}>
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : editing ? <Pencil className="h-4 w-4" /> : <Send className="h-5 w-5" />}
        </button>
      </div>
    </div>
  )
}
