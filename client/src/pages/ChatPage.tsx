// ============================================================================
// §17 — Chat. Two panes on a wide screen; on a phone the list and then the
// conversation, each full screen. The route carries the open conversation.
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
    <div className="-mx-4 -my-5 h-[calc(100dvh-4rem)] sm:-mx-6 lg:-mx-8 lg:py-4 lg:px-8">
      <Card className="grid h-full min-h-0 grid-cols-1 overflow-hidden rounded-none lg:grid-cols-[22rem_1fr] lg:rounded-2xl">
        <aside className={cn('min-h-0 border-r border-slate-200 dark:border-slate-800', conversationId ? 'hidden lg:block' : 'block')}>
          {isLoading ? (
            <p className="p-6 text-sm text-slate-400">Loading…</p>
          ) : (
            <ConversationList conversations={conversations} activeId={active?.id ?? null} onPick={open} onNew={() => setCreating(true)} myId={profile?.id ?? ''} />
          )}
        </aside>
        <section className={cn('min-h-0', conversationId ? 'block' : 'hidden lg:block')}>
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
