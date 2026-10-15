import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, MessageSquarePlus, Search, Users } from 'lucide-react'
import type { ChatConversation, ChatUser } from '@qc/shared/types'
import { Button, Field, Input, Modal } from '@/components/ui'
import { useChatUsers } from '@/services/queries'
import { createConversation } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { isCoarsePointer } from '@/lib/media'
import { cn } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/UserAvatar'

export function NewChatModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: ChatConversation) => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { profile, can } = useAuth()
  const { data: users = [] } = useChatUsers()
  const [tab, setTab] = useState<'direct' | 'group'>('direct')
  const [term, setTerm] = useState('')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const others = useMemo(() => {
    const q = term.trim().toLowerCase()
    return users.filter((u) => u.id !== profile?.id && (!q || u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)))
  }, [users, term, profile?.id])

  const open = async (body: Parameters<typeof createConversation>[1]) => {
    setBusy(true)
    try {
      const c = await createConversation(qc, body)
      onCreated(c)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the conversation.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const Row = ({ u, selected, onClick }: { u: ChatUser; selected?: boolean; onClick: () => void }) => (
    <li>
      <button type="button" onClick={onClick} disabled={busy} className={cn('flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800', selected && 'bg-brand-50 dark:bg-brand-500/15')}>
        <UserAvatar userId={u.id} name={u.name} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{u.name}</span>
          <span className="block truncate text-xs capitalize text-muted">{u.username} · {u.role}</span>
        </span>
        {selected && <Check className="h-4 w-4 text-brand-600" />}
      </button>
    </li>
  )

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<MessageSquarePlus className="h-5 w-5" />}
      title="New chat"
      footer={
        tab === 'group' ? (
          <>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" disabled={busy || !name.trim() || picked.size === 0} onClick={() => void open({ kind: 'group', name: name.trim(), memberIds: [...picked] })}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />} Create group
            </Button>
          </>
        ) : undefined
      }
    >
      {can('manage-chat') && (
        <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {(['direct', 'group'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t} className={cn('flex-1 rounded-lg py-2.5 text-sm font-semibold touch:min-h-[44px]', tab === t ? 'bg-white shadow-card dark:bg-slate-900' : 'text-muted')}>
              {t === 'direct' ? 'Direct message' : 'Group'}
            </button>
          ))}
        </div>
      )}
      {tab === 'group' && (
        <Field label="Group name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Welding LM4" maxLength={80} autoFocus={!isCoarsePointer()} />
        </Field>
      )}
      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Find a person" className="pl-9" autoFocus={tab === 'direct' && !isCoarsePointer()} />
      </div>
      <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto">
        {others.map((u) =>
          tab === 'direct' ? (
            <Row key={u.id} u={u} onClick={() => void open({ kind: 'direct', userId: u.id })} />
          ) : (
            <Row key={u.id} u={u} selected={picked.has(u.id)} onClick={() => setPicked((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n })} />
          ),
        )}
        {others.length === 0 && <li className="py-6 text-center text-sm text-muted">Nobody matches.</li>}
      </ul>
      {tab === 'group' && picked.size > 0 && <p className="mt-2 text-xs text-muted">{picked.size} selected, plus you.</p>}
    </Modal>
  )
}
