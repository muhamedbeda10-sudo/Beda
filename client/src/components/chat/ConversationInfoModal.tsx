import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Pencil, UserMinus, UserPlus, Users } from 'lucide-react'
import type { ChatConversation } from '@qc/shared/types'
import { Badge, Button, Input, Modal } from '@/components/ui'
import { useChatUsers } from '@/services/queries'
import { updateGroup } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { initialsOf } from './ConversationList'

/** Who is in the conversation; an administrator renames a group and changes its members. */
export function ConversationInfoModal({ conversation: c, onClose, onOpenDirect }: { conversation: ChatConversation; onClose: () => void; onOpenDirect: (userId: string) => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { role, profile } = useAuth()
  const admin = role === 'admin' && c.kind === 'group'
  const { data: users = [] } = useChatUsers(admin)
  const [name, setName] = useState(c.title)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const candidates = useMemo(() => users.filter((u) => !c.members.some((m) => m.id === u.id)), [users, c.members])

  const change = async (body: Parameters<typeof updateGroup>[2]) => {
    setBusy(true)
    try {
      await updateGroup(qc, c.id, body)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the group.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="md" icon={<Users className="h-5 w-5" />} title={c.kind === 'general' ? 'General' : c.kind === 'group' ? 'Group' : 'Conversation'}>
      {admin && (
        <div className="mb-3 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Group name" />
          <Button variant="primary" disabled={busy || !name.trim() || name.trim() === c.title} onClick={() => void change({ name: name.trim() })}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />} Rename
          </Button>
        </div>
      )}
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
        {c.members.length} member{c.members.length === 1 ? '' : 's'}
        {c.kind === 'general' && ' · everyone'}
      </p>
      <ul className="mt-1 max-h-72 space-y-0.5 overflow-y-auto">
        {c.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-xs font-bold text-white">{initialsOf(m.name)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {m.name} {m.id === profile?.id && <span className="text-xs font-normal text-slate-400">(you)</span>}
              </span>
              <span className="block text-xs capitalize text-slate-400">{m.role}</span>
            </span>
            {m.id !== profile?.id && c.kind !== 'direct' && (
              <button type="button" onClick={() => onOpenDirect(m.id)} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
                Message
              </button>
            )}
            {admin && m.id !== profile?.id && (
              <button type="button" onClick={() => void change({ removeMemberIds: [m.id] })} disabled={busy} className="icon-btn h-9 w-9 hover:text-rose-600" aria-label={`Remove ${m.name}`}>
                <UserMinus className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {admin && (
        <div className="mt-3">
          {!adding ? (
            <Button onClick={() => setAdding(true)} disabled={candidates.length === 0}>
              <UserPlus className="h-4 w-4" /> Add people
            </Button>
          ) : (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 p-1 dark:border-slate-800">
              {candidates.map((u) => (
                <li key={u.id}>
                  <button type="button" disabled={busy} onClick={() => void change({ addMemberIds: [u.id] })} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Check className="h-4 w-4 text-slate-300" /> {u.name} <Badge tone="neutral" className="ml-auto capitalize">{u.role}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}
