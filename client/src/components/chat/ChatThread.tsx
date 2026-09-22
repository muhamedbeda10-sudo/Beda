// ============================================================================
// One conversation open: the header, the messages by day, the composer.
// Polls quietly while open, marks itself read when the tab is visible, and
// loads older pages as the reader scrolls up.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, Info, Loader2, Trash2, UserPlus } from 'lucide-react'
import type { ChatConversation, ChatMessage } from '@qc/shared/types'
import { Button, Modal } from '@/components/ui'
import { useChatMessages } from '@/services/queries'
import { deleteChatMessage, editChatMessage, loadOlderMessages, markConversationRead, sendChatMessage, toggleReaction } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'
import { Avatar } from './ConversationList'
import { Composer } from './Composer'
import { ConversationInfoModal } from './ConversationInfoModal'
import { EmojiPicker } from './EmojiPicker'
import { MessageBubble } from './MessageBubble'
import { useMentionPanel } from './MentionPanel'

const dayLabel = (iso: string) => {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

export function ChatThread({
  conversation: c,
  onBack,
  onOpenDirect,
  onDeleted,
}: {
  conversation: ChatConversation
  onBack?: () => void
  onOpenDirect: (userId: string) => void
  /** An administrator deleted this group: leave it. */
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { profile, role } = useAuth()
  const myId = profile?.id ?? ''
  const { data, isLoading } = useChatMessages(c.id)
  const [older, setOlder] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<ChatMessage | null>(null)
  const [confirm, setConfirm] = useState<{ m: ChatMessage; scope: 'me' | 'everyone' } | null>(null)
  const [reactFor, setReactFor] = useState<ChatMessage | null>(null)
  const [info, setInfo] = useState<false | 'members' | 'add'>(false)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const lastSeen = useRef<string | null>(null)
  const { handle: onMention, panel } = useMentionPanel(onOpenDirect)

  // A new conversation: forget the older pages of the previous one.
  useEffect(() => {
    setOlder([])
    setHasMore(false)
    setReplyTo(null)
    setEditing(null)
    lastSeen.current = null
  }, [c.id])

  useEffect(() => {
    if (data) setHasMore((prev) => (older.length === 0 ? data.hasMore : prev))
  }, [data, older.length])

  const messages = useMemo(() => {
    const latest = data?.messages ?? []
    const seen = new Set(latest.map((m) => m.id))
    return [...older.filter((m) => !seen.has(m.id)), ...latest]
  }, [older, data])

  // Scroll to the bottom on open and on a new message when already there; mark read when visible.
  useEffect(() => {
    const last = messages.at(-1)
    if (!last) return
    const el = scroller.current
    if (lastSeen.current === null || atBottom) {
      requestAnimationFrame(() => el?.scrollTo({ top: el.scrollHeight }))
    }
    if (lastSeen.current !== last.id && document.visibilityState === 'visible') {
      lastSeen.current = last.id
      if (c.unreadCount > 0 || last.senderId !== myId) void markConversationRead(qc, c.id).catch(() => undefined)
    }
  }, [messages, atBottom, c.id, c.unreadCount, myId, qc])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    if (el.scrollTop < 60 && hasMore && !loadingOlder) void loadMore()
  }

  const loadMore = async () => {
    const first = messages[0]
    if (!first) return
    setLoadingOlder(true)
    const el = scroller.current
    const before = el ? el.scrollHeight - el.scrollTop : 0
    try {
      const page = await loadOlderMessages(c.id, first.createdAt)
      setOlder((o) => [...page.messages, ...o])
      setHasMore(page.hasMore)
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before
      })
    } catch {
      toast('Older messages could not be loaded.', 'error')
    } finally {
      setLoadingOlder(false)
    }
  }

  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlight(id)
    setTimeout(() => setHighlight(null), 1500)
  }, [])

  const send = async (body: string, imageIds: string[], fileIds: string[], clientId: string) => {
    await sendChatMessage(qc, c.id, { clientId, body, imageIds, fileIds, replyToId: replyTo?.id ?? null })
    setReplyTo(null)
    setAtBottom(true)
  }

  const saveEdit = async (body: string) => {
    if (!editing) return
    await editChatMessage(qc, editing.id, body)
    setEditing(null)
  }

  const react = async (m: ChatMessage, emoji: string) => {
    if (!emoji) {
      setReactFor(m)
      return
    }
    try {
      await toggleReaction(qc, m.id, emoji)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not react.', 'error')
    }
  }

  const doDelete = async () => {
    if (!confirm) return
    try {
      await deleteChatMessage(qc, confirm.m.id, confirm.scope)
      setOlder((o) => (confirm.scope === 'me' ? o.filter((x) => x.id !== confirm.m.id) : o))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete.', 'error')
    } finally {
      setConfirm(null)
    }
  }

  const canModerate = role === 'admin' && c.kind !== 'direct'
  const subtitle = c.kind === 'direct' ? c.members.find((m) => m.id !== myId)?.role ?? '' : `${c.members.length} members`

  let lastDay = ''
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white/95 px-2 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 sm:px-3">
        {onBack && (
          <button type="button" onClick={onBack} className="icon-btn h-10 w-10 lg:hidden" aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <button type="button" onClick={() => setInfo('members')} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-1 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
          <Avatar conversation={c} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold">{c.title}</span>
            <span className={cn('block truncate text-xs text-slate-400', c.kind === 'direct' && 'capitalize')}>{subtitle}</span>
          </span>
        </button>
        {/* An administrator adds people to a group from here, after it was made. */}
        {role === 'admin' && c.kind === 'group' && (
          <button type="button" onClick={() => setInfo('add')} className="icon-btn h-10 w-10" aria-label="Add people" title="Add people to this group">
            <UserPlus className="h-5 w-5" />
          </button>
        )}
        <button type="button" onClick={() => setInfo('members')} className="icon-btn h-10 w-10" aria-label="Conversation info">
          <Info className="h-5 w-5" />
        </button>
      </header>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_1px_1px,rgba(15,23,42,.06)_1px,transparent_0)] [background-size:18px_18px] px-3 py-3 dark:bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,.05)_1px,transparent_0)] sm:px-6">
        {isLoading && (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {hasMore && (
          <div className="flex justify-center pb-2">
            <button type="button" onClick={() => void loadMore()} disabled={loadingOlder} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500 shadow ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
              {loadingOlder ? 'Loading…' : 'Earlier messages'}
            </button>
          </div>
        )}
        {!isLoading && messages.length === 0 && <p className="py-16 text-center text-sm text-slate-400">No messages yet. Say hello.</p>}
        <div className="space-y-1.5">
          {messages.map((m, i) => {
            const day = dayLabel(m.createdAt)
            const sep = day !== lastDay
            lastDay = day
            const prev = messages[i - 1]
            const grouped = !!prev && prev.senderId === m.senderId && !sep && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000
            return (
              <div key={m.id} className={cn(grouped ? 'mt-0.5' : 'mt-3')}>
                {sep && (
                  <div className="my-3 flex justify-center">
                    <span className="rounded-full bg-white px-3 py-0.5 text-[11px] font-semibold text-slate-500 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">{day}</span>
                  </div>
                )}
                <MessageBubble
                  message={m}
                  mine={m.senderId === myId}
                  showSender={c.kind !== 'direct' && !grouped}
                  canModerate={canModerate}
                  highlighted={highlight === m.id}
                  actions={{ onReply: setReplyTo, onEdit: setEditing, onDelete: (mm, scope) => setConfirm({ m: mm, scope }), onReact: react, onMention, onJumpTo: jumpTo }}
                />
              </div>
            )
          })}
        </div>
        {!atBottom && (
          <button type="button" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })} className="sticky bottom-2 left-full grid h-9 w-9 place-items-center rounded-full bg-white text-slate-600 shadow-lift ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700" aria-label="Jump to latest">
            <ChevronDown className="h-5 w-5" />
          </button>
        )}
      </div>

      <Composer conversationId={c.id} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} editing={editing} onCancelEdit={() => setEditing(null)} onSend={send} onSaveEdit={saveEdit} />

      {reactFor && (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" onClick={() => setReactFor(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <EmojiPicker onPick={(e) => { void react(reactFor, e); setReactFor(null) }} onClose={() => setReactFor(null)} className="mb-4 sm:mb-0" />
          </div>
        </div>
      )}
      {info && <ConversationInfoModal key={info} conversation={c} startAdding={info === 'add'} onClose={() => setInfo(false)} onOpenDirect={(id) => { setInfo(false); onOpenDirect(id) }} onDeleted={() => { setInfo(false); onDeleted() }} />}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          size="sm"
          title={confirm.scope === 'everyone' ? 'Delete for everyone?' : 'Delete for you?'}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Keep</Button>
              <Button variant="danger" onClick={() => void doDelete()}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {confirm.scope === 'everyone' ? 'Everyone in the conversation will see "Message deleted" instead.' : 'It disappears from your view only; others still see it.'}
          </p>
        </Modal>
      )}
      {panel}
    </div>
  )
}
