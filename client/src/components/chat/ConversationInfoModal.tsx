import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, Trash2, UserMinus, UserPlus, Users } from 'lucide-react'
import type { ChatConversation } from '@qc/shared/types'
import { Badge, Button, Input, Modal } from '@/components/ui'
import { useChatUsers } from '@/services/queries'
import { deleteGroup, updateGroup } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { useAuth } from '@/store/AuthContext'
import { initialsOf } from './ConversationList'

/** Who is in the conversation; an administrator renames a group, changes its members, or deletes it. */
export function ConversationInfoModal({
  conversation: c,
  onClose,
  onOpenDirect,
  onDeleted,
  startAdding = false,
}: {
  conversation: ChatConversation
  onClose: () => void
  onOpenDirect: (userId: string) => void
  /** The group is gone: the caller leaves it. */
  onDeleted: () => void
  /** Open straight onto the people to add. */
  startAdding?: boolean
}) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { role, profile } = useAuth()
  const admin = role === 'admin' && c.kind === 'group'
  const { data: users = [] } = useChatUsers(admin)
  const [name, setName] = useState(c.title)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(startAdding)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
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

  const remove = async () => {
    setBusy(true)
    try {
      await deleteGroup(qc, c.id)
      toast(`Group "${c.title}" deleted.`, 'success')
      onDeleted()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the group.', 'error')
      setBusy(false)
    }
  }

  if (confirmDelete) {
    return (
      <Modal
        open
        onClose={() => !busy && setConfirmDelete(false)}
        size="sm"
        icon={<Trash2 className="h-5 w-5" />}
        title="Delete this group?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} disabled={busy}>
              Keep
            </Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete group
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          <span className="font-semibold text-slate-800 dark:text-slate-100">{c.title}</span> disappears for all {c.members.length} member{c.members.length === 1 ? '' : 's'}. Nobody can read or write in it afterwards. The deletion is written to the audit log.
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<Users className="h-5 w-5" />}
      title={c.kind === 'general' ? 'General' : c.kind === 'group' ? 'Group' : 'Conversation'}
      footer={
        admin ? (
          <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
            <Trash2 className="h-4 w-4" /> Delete group
          </Button>
        ) : undefined
      }
    >
      {admin && (
        <div className="mb-3 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Group name" />
          <Button variant="primary" disabled={busy || !name.trim() || name.trim() === c.title} onClick={() => void change({ name: name.trim() })}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />} Rename
          </Button>
        </div>
      )}
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">
        {c.members.length} member{c.members.length === 1 ? '' : 's'}
        {c.kind === 'general' && ' · everyone'}
      </p>
      <ul className="mt-1 max-h-72 space-y-0.5 overflow-y-auto">
        {c.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 text-xs font-bold text-white">{initialsOf(m.name)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {m.name} {m.id === profile?.id && <span className="text-xs font-normal text-muted">(you)</span>}
              </span>
              <span className="block text-xs capitalize text-muted">{m.role}</span>
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
            // Tick several, add them at once.
            <div className="space-y-2">
              <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 p-1 dark:border-slate-800">
                {candidates.length === 0 && <li className="px-2 py-2 text-sm text-muted">Everyone is already in this group.</li>}
                {candidates.map((u) => {
                  const on = picked.has(u.id)
                  return (
                    <li key={u.id}>
                      <label className="flex min-h-[40px] cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy}
                          onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n })}
                          className="h-4 w-4 accent-brand-600"
                        />
                        {u.name} <Badge tone="neutral" className="ml-auto capitalize">{u.role}</Badge>
                      </label>
                    </li>
                  )
                })}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={busy || picked.size === 0}
                  onClick={() => void change({ addMemberIds: Array.from(picked) }).then(() => { setPicked(new Set()); setAdding(false) })}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Add {picked.size > 0 ? picked.size : ''}
                </Button>
                <Button onClick={() => { setPicked(new Set()); setAdding(false) }} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
