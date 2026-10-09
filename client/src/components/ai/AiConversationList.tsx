// ============================================================================
// §20 — this person's conversations with the assistant, the latest
// first: search their titles, open one, remove one, page back through older.
// ============================================================================

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, MessageSquarePlus, MessageSquareText, Search, Trash2 } from 'lucide-react'
import type { AiConversation } from '@qc/shared/ai'
import { Button, Input, Modal } from '@/components/ui'
import { cn, formatDate, formatFullTimestamp, formatTime } from '@/lib/utils'
import { deleteAiConversation } from '@/services/mutations'
import { loadOlderAiConversations, useAiConversations } from '@/services/queries'
import { useApp } from '@/store/AppContext'
import { useAi, useAiLive } from './AiAssistantProvider'
import { isInFlight } from './liveTurn'

/** Today's time, or the day. */
const when = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDate(iso))

export function AiConversationList({ onPicked, onNew }: { onPicked: () => void; onNew: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { conversationId, openConversation, enabled } = useAi()
  const live = useAiLive()
  const { data, isLoading, isError, refetch } = useAiConversations(enabled)
  const [older, setOlder] = useState<AiConversation[]>([])
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [term, setTerm] = useState('')
  const [removing, setRemoving] = useState<AiConversation | null>(null)
  const [busy, setBusy] = useState(false)

  // The first page stays fresh; older pages are appended, and a conversation is listed once.
  const all = useMemo(() => {
    const seen = new Set<string>()
    const out: AiConversation[] = []
    for (const c of [...(data?.conversations ?? []), ...older]) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push(c)
    }
    return out
  }, [data, older])
  const hasMore = olderHasMore ?? data?.hasMore ?? false
  const list = useMemo(() => {
    const q = term.trim().toLowerCase()
    return q ? all.filter((c) => c.title.toLowerCase().includes(q)) : all
  }, [all, term])

  const writingIn = isInFlight(live) ? live?.conversationId : undefined

  const loadMore = async () => {
    const last = all.at(-1)
    if (!last || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await loadOlderAiConversations(last.lastMessageAt)
      setOlder((o) => [...o, ...page.conversations])
      setOlderHasMore(page.hasMore)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Older conversations could not be loaded.', 'error')
    } finally {
      setLoadingOlder(false)
    }
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await deleteAiConversation(qc, removing.id)
      setOlder((o) => o.filter((c) => c.id !== removing.id))
      if (conversationId === removing.id) openConversation(null)
      toast('Conversation deleted.', 'success')
      setRemoving(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the conversation.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search your conversations" className="rounded-full pl-9" aria-label="Search your conversations" dir="auto" />
        </div>
        <button type="button" onClick={onNew} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white shadow-card hover:bg-brand-700 touch:h-11 touch:w-11" aria-label="New chat" data-tip="New chat">
          <MessageSquarePlus className="h-5 w-5" />
        </button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {isLoading && (
          <li className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </li>
        )}
        {isError && !data && (
          <li className="px-3 py-8 text-center text-sm text-muted">
            Your conversations could not be loaded.{' '}
            <button type="button" onClick={() => void refetch()} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">
              Try again
            </button>
          </li>
        )}
        {list.map((c) => {
          const active = c.id === conversationId
          const writing = c.id === writingIn
          return (
            <li key={c.id} className={cn('group flex items-center gap-1 rounded-2xl pe-1 transition-colors', active ? 'bg-brand-50 ring-1 ring-brand-200 dark:bg-brand-500/15 dark:ring-brand-500/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800')}>
              <button
                type="button"
                onClick={() => {
                  openConversation(c.id)
                  onPicked()
                }}
                aria-current={active ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">
                  {writing ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block truncate text-sm font-semibold">
                    {c.title}
                  </span>
                  <time dateTime={c.lastMessageAt} data-tip={formatFullTimestamp(c.lastMessageAt)} className="block text-[11px] tabular-nums text-muted">
                    {writing ? 'Answering…' : when(c.lastMessageAt)}
                  </time>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRemoving(c)}
                disabled={writing}
                aria-label={`Delete the conversation "${c.title}"`}
                data-tip={writing ? 'Still answering' : 'Delete'}
                className="icon-btn h-9 w-9 shrink-0 opacity-0 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30 [@media(hover:none)]:opacity-100 touch:h-11 touch:w-11"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          )
        })}
        {!isLoading && !isError && list.length === 0 && (
          <li className="px-3 py-10 text-center text-sm text-muted">{term.trim() ? 'No conversation matches.' : 'No conversations yet. Ask a first question.'}</li>
        )}
        {hasMore && !term.trim() && (
          <li className="flex justify-center pt-2">
            <button type="button" onClick={() => void loadMore()} disabled={loadingOlder} className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-muted shadow ring-1 ring-slate-200 hover:text-slate-700 dark:bg-slate-800 dark:ring-slate-700 dark:hover:text-slate-200 touch:min-h-[44px]">
              {loadingOlder ? 'Loading…' : 'Older conversations'}
            </button>
          </li>
        )}
      </ul>

      {removing && (
        <Modal
          open
          onClose={() => !busy && setRemoving(null)}
          size="sm"
          title="Delete this conversation?"
          footer={
            <>
              <Button onClick={() => setRemoving(null)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <b dir="auto">{removing.title}</b>
            <br />
            It leaves your list.
          </p>
        </Modal>
      )}
    </div>
  )
}
