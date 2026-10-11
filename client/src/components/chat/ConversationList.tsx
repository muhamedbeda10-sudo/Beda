import { useMemo, useState } from 'react'
import { AtSign, Hash, MessageSquarePlus, Search, Users, Zap } from 'lucide-react'
import type { ChatConversation } from '@qc/shared/types'
import { Input } from '@/components/ui'
import { cn, formatDate, formatTime } from '@/lib/utils'
import { messageDirection } from '@/lib/direction'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { appLinkSegments } from './appLinks'

/** §21 — what the automations sender's conversation is called, whoever reads it. */
export const AUTOMATED_TITLE = 'QC Automations'

/** A conversation's name as the list and its header show it. */
export const conversationTitle = (c: Pick<ChatConversation, 'title' | 'automated'>): string => (c.automated ? AUTOMATED_TITLE : c.title)

/** §21 — an automated message's preview reads its links by what they open, not as addresses. */
const previewOf = (c: Pick<ChatConversation, 'automated'>, text: string): string =>
  c.automated ? appLinkSegments(text).map((s) => (s.type === 'text' ? s.text : s.label)).join('') : text

const when = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? formatTime(iso) : formatDate(iso)
}

/**
 * A conversation's circle: the other person's photo or initials in a direct chat, a mark for a group or the
 * general channel, and the automations' mark for the messages automations send (§21).
 */
export function Avatar({ conversation: c, myId, size = 'md' }: { conversation: Pick<ChatConversation, 'kind' | 'title' | 'members' | 'automated'>; myId: string; size?: 'sm' | 'md' }) {
  const cls = cn('grid shrink-0 place-items-center rounded-full font-bold text-white shadow-card', size === 'md' ? 'h-11 w-11 text-sm' : 'h-8 w-8 text-xs')
  if (c.automated) return <span className={cn(cls, 'bg-gradient-to-br from-amber-500 to-orange-600')} aria-hidden><Zap className={size === 'md' ? 'h-5 w-5' : 'h-4 w-4'} /></span>
  if (c.kind === 'general') return <span className={cn(cls, 'bg-gradient-to-br from-accent-500 to-accent-700')}><Hash className="h-5 w-5" /></span>
  if (c.kind === 'group') return <span className={cn(cls, 'bg-gradient-to-br from-violet-500 to-violet-700')}><Users className="h-5 w-5" /></span>
  const other = c.members.find((m) => m.id !== myId) ?? c.members[0]
  return <UserAvatar userId={other?.id ?? ''} name={other?.name ?? c.title} size={size === 'md' ? 44 : 32} />
}

export function ConversationList({ conversations, activeId, onPick, onNew, myId }: { conversations: ChatConversation[]; activeId: string | null; onPick: (c: ChatConversation) => void; onNew: () => void; myId: string }) {
  const [term, setTerm] = useState('')
  const list = useMemo(() => {
    const q = term.trim().toLowerCase()
    return q ? conversations.filter((c) => conversationTitle(c).toLowerCase().includes(q) || c.members.some((m) => m.name.toLowerCase().includes(q))) : conversations
  }, [conversations, term])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search" className="rounded-full pl-9" aria-label="Search conversations" />
        </div>
        <button type="button" onClick={onNew} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white shadow-card hover:bg-brand-700" aria-label="New chat">
          <MessageSquarePlus className="h-5 w-5" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {list.map((c) => {
          const active = c.id === activeId
          const last = c.lastMessage
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className={cn('flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left transition-colors', active ? 'bg-brand-50 ring-1 ring-brand-200 dark:bg-brand-500/15 dark:ring-brand-500/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800')}
              >
                <Avatar conversation={c} myId={myId} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn('truncate text-sm', c.unreadCount > 0 ? 'font-bold' : 'font-semibold')}>{conversationTitle(c)}</span>
                    <span className={cn('shrink-0 text-[11px] tabular-nums', c.unreadCount > 0 ? 'font-bold text-brand-700 dark:text-brand-300' : 'text-muted')}>{when(last?.createdAt ?? c.lastMessageAt)}</span>
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn('truncate text-xs', c.unreadCount > 0 ? 'text-slate-700 dark:text-slate-200' : 'text-muted')}>
                      {last ? (
                        <>
                          {last.senderId === myId ? 'You' : c.kind === 'direct' ? '' : <bdi>{last.senderName}</bdi>}
                          {last.senderId === myId || c.kind !== 'direct' ? ': ' : ''}
                          <bdi dir={messageDirection(last.text) ?? 'auto'}>{previewOf(c, last.text)}</bdi>
                        </>
                      ) : c.kind === 'group' ? (
                        `${c.members.length} members`
                      ) : (
                        'No messages yet'
                      )}
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brand-600 px-1.5 text-[10px] font-bold leading-[18px] text-white">
                        {c.mentionCount > 0 && <AtSign className="h-3 w-3" />}
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
        {list.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No conversation matches.</li>}
      </ul>
    </div>
  )
}
