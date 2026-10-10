import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CheckCheck, CornerUpLeft, Copy, MoreHorizontal, Pencil, SmilePlus, Trash2 } from 'lucide-react'
import { CHAT_EDIT_WINDOW_MS, type ChatMention, type ChatMessage } from '@qc/shared/types'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { NoticeFileRow } from '@/components/notices/NoticeCard'
import { cn, formatTime } from '@/lib/utils'
import { QUICK_REACTIONS } from './emoji'
import { MessageBody } from './MessageBody'
import { plainText } from './mentions'

const timeOf = (iso: string) => formatTime(iso)

export interface BubbleActions {
  onReply: (m: ChatMessage) => void
  onEdit: (m: ChatMessage) => void
  onDelete: (m: ChatMessage, scope: 'me' | 'everyone') => void
  onReact: (m: ChatMessage, emoji: string) => void
  onMention: (m: ChatMention) => void
  onJumpTo: (id: string) => void
}

/** One message as WhatsApp draws it: mine on the right in brand, theirs on the left. */
export function MessageBubble({
  message: m,
  mine,
  showSender,
  canModerate,
  actions,
  highlighted,
  lead,
  automated = false,
}: {
  message: ChatMessage
  mine: boolean
  showSender: boolean
  /** An administrator in a channel may delete for everyone. */
  canModerate: boolean
  actions: BubbleActions
  highlighted?: boolean
  /** Before someone else's bubble: their circle, or the space it takes. */
  lead?: ReactNode
  /** §21 — from the automations sender: its addresses open in place, and nothing is answered to it. */
  automated?: boolean
}) {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  const withinWindow = Date.now() - new Date(m.createdAt).getTime() <= CHAT_EDIT_WINDOW_MS
  const allRead = m.others > 0 && m.readBy >= m.others
  const someRead = m.readBy > 0

  return (
    <div id={`msg-${m.id}`} className={cn('group flex w-full', mine ? 'justify-end' : 'justify-start', !!lead && 'items-start gap-2')}>
      {!mine && lead}
      <div ref={ref} className={cn('relative max-w-[85%] sm:max-w-[70%]', highlighted && 'animate-pulse')}>
        <div
          className={cn(
            'rounded-2xl px-3 py-2 text-sm shadow-sm',
            mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-white text-slate-800 ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700',
            m.deleted && 'italic opacity-70',
          )}
        >
          {showSender && !mine && <p className="mb-0.5 text-[11px] font-bold text-accent-600 dark:text-accent-400">{m.senderName}</p>}
          {m.replyTo && (
            <button
              type="button"
              onClick={() => actions.onJumpTo(m.replyTo!.id)}
              className={cn('mb-1.5 block w-full rounded-lg border-l-4 px-2 py-1 text-left text-xs', mine ? 'border-white/60 bg-white/15' : 'border-brand-500 bg-slate-100 dark:bg-slate-700/60')}
            >
              <span className="block font-bold">{m.replyTo.senderName}</span>
              <span className="line-clamp-2 opacity-80">{m.replyTo.text || '…'}</span>
            </button>
          )}
          {m.deleted ? (
            <span className="inline-flex items-center gap-1">
              <Trash2 className="h-3.5 w-3.5" /> Message deleted
            </span>
          ) : (
            <>
              {m.imageIds.length > 0 && (
                <div className="mb-1.5">
                  <ImagePicker imageIds={m.imageIds} onChange={() => {}} readOnly />
                </div>
              )}
              {m.files.length > 0 && (
                <div className={cn('mb-1.5 space-y-1', mine && '[&_button]:border-white/30 [&_button]:text-white [&_button:hover]:bg-white/10 [&_span.text-muted]:text-white/70')}>
                  {m.files.map((f) => (
                    <NoticeFileRow key={f.id} file={f} path={`/chat/files/${f.id}/content`} compact />
                  ))}
                </div>
              )}
              {m.body && <MessageBody body={m.body} mine={mine} onMention={actions.onMention} appLinks={automated} />}
            </>
          )}
          <span className={cn('mt-1 flex items-center justify-end gap-1 text-[10px] tabular-nums', mine ? 'text-white/70' : 'text-muted')}>
            {m.editedAt && !m.deleted && <span>edited ·</span>}
            {timeOf(m.createdAt)}
            {mine && !m.deleted && (allRead ? <CheckCheck className="h-3.5 w-3.5 text-sky-200" /> : someRead ? <CheckCheck className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />)}
          </span>
        </div>

        {m.reactions.length > 0 && (
          <div className={cn('-mt-1.5 flex flex-wrap gap-1', mine ? 'justify-end pr-1' : 'pl-1')}>
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => actions.onReact(m, r.emoji)}
                data-tip={r.names.join(', ')}
                className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-sm', r.mine ? 'border-brand-400 bg-brand-50 dark:border-brand-500/60 dark:bg-brand-500/20' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800')}
              >
                <span>{r.emoji}</span>
                <span className="tabular-nums text-slate-600 dark:text-slate-300">{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {!m.deleted && (
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            aria-label="Message actions"
            className={cn(
              'absolute top-1 grid h-7 w-7 place-items-center rounded-full bg-white/90 text-muted shadow ring-1 ring-slate-200 transition-opacity dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600',
              mine ? '-left-8' : '-right-8',
              menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-60',
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}

        {menu && (
          <div className={cn('absolute z-20 mt-1 w-56 rounded-2xl bg-white p-1.5 shadow-lift ring-1 ring-slate-200 animate-scale-in dark:bg-slate-900 dark:ring-slate-700', mine ? 'right-0' : 'left-0')}>
            {!automated && (
              <>
                <div className="mb-1 flex justify-between px-1">
                  {QUICK_REACTIONS.map((e) => (
                    <button key={e} type="button" onClick={() => { actions.onReact(m, e); setMenu(false) }} className="rounded-lg p-1 text-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                      {e}
                    </button>
                  ))}
                </div>
                <MenuItem icon={<CornerUpLeft className="h-4 w-4" />} label="Reply" onClick={() => { actions.onReply(m); setMenu(false) }} />
                <MenuItem icon={<SmilePlus className="h-4 w-4" />} label="React…" onClick={() => { actions.onReact(m, ''); setMenu(false) }} />
              </>
            )}
            <MenuItem icon={<Copy className="h-4 w-4" />} label="Copy text" onClick={() => { void navigator.clipboard?.writeText(plainText(m.body)); setMenu(false) }} />
            {mine && withinWindow && m.body && <MenuItem icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={() => { actions.onEdit(m); setMenu(false) }} />}
            <MenuItem icon={<Trash2 className="h-4 w-4" />} label="Delete for me" onClick={() => { actions.onDelete(m, 'me'); setMenu(false) }} />
            {((mine && withinWindow) || canModerate) && (
              <MenuItem icon={<Trash2 className="h-4 w-4" />} label="Delete for everyone" danger onClick={() => { actions.onDelete(m, 'everyone'); setMenu(false) }} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800', danger ? 'text-rose-600' : 'text-slate-700 dark:text-slate-200')}>
      {icon} {label}
    </button>
  )
}
