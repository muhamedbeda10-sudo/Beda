// ============================================================================
// §17 — Chat. Two panes from a portrait tablet (md) up; on a phone the list
// and then the conversation, each full screen. The route carries the open
// conversation. The page fills the room the shell gives it under the header
// (AppShell's main, with its padding undone here; contain: size, so a long
// thread never grows it past that room) and its foot runs to the
// screen's bottom edge — the shell keeps no safe area under the chat — where
// the composer keeps clear of the home indicator itself.
// ============================================================================

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { MessagesSquare } from 'lucide-react'
import type { ChatConversation } from '@qc/shared/types'
import { Card, EmptyState } from '@/components/ui'
import { ChatThread } from '@/components/chat/ChatThread'
import { ConversationList } from '@/components/chat/ConversationList'
import { NewChatModal } from '@/components/chat/NewChatModal'
import { useChatConversations } from '@/services/queries'
import { createConversation } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { cn } from '@/lib/utils'

export function ChatPage() {
  const { conversationId = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { toast } = useApp()
  const { profile } = useAuth()
  const { data, isLoading } = useChatConversations()
  const [creating, setCreating] = useState(false)
  const conversations = data?.conversations ?? []
  const active = conversations.find((c) => c.id === conversationId) ?? null

  // A stale id in the address: fall back to the list.
  useEffect(() => {
    if (conversationId && data && !active) navigate('/chat', { replace: true })
  }, [conversationId, data, active, navigate])

  const open = (c: ChatConversation) => navigate(`/chat/${c.id}`)
  const openDirect = async (userId: string) => {
    if (userId === profile?.id) return
    try {
      const c = await createConversation(qc, { kind: 'direct', userId })
      navigate(`/chat/${c.id}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not open the conversation.', 'error')
    }
  }

  return (
    <div className="-mx-3 -mb-3 -mt-3 h-[calc(100%+1.5rem)] [contain:size] sm:-mx-4 md:p-3">
      <Card className="grid h-full min-h-0 grid-cols-1 overflow-hidden rounded-none md:grid-cols-[18rem_1fr] md:rounded-2xl lg:grid-cols-[22rem_1fr]">
        <aside className={cn('min-h-0 border-r border-slate-200 dark:border-slate-800', conversationId ? 'hidden md:block' : 'block')}>
          {isLoading ? (
            <p className="p-6 text-sm text-muted">Loading…</p>
          ) : (
            <ConversationList conversations={conversations} activeId={active?.id ?? null} onPick={open} onNew={() => setCreating(true)} myId={profile?.id ?? ''} />
          )}
        </aside>
        <section className={cn('min-h-0', conversationId ? 'block' : 'hidden md:block')}>
          {active ? (
            <ChatThread conversation={active} onBack={() => navigate('/chat')} onOpenDirect={(id) => void openDirect(id)} onDeleted={() => navigate('/chat', { replace: true })} />
          ) : (
            <div className="grid h-full place-items-center p-6">
              <EmptyState icon={<MessagesSquare className="h-10 w-10" />} title="Pick a conversation" hint="Or start one with the + button. @ mentions a person; # points at an order, an item, a machine or a session." />
            </div>
          )}
        </section>
      </Card>
      {creating && <NewChatModal onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); open(c) }} />}
    </div>
  )
}
