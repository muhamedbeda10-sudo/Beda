// ============================================================================
// §14 — accounts and roles. An account can be deactivated (and brought back)
// or removed for good; history keeps the person's name either way.
// ============================================================================

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, Pencil, RotateCcw, ShieldAlert, Trash2, UserCog, UserPlus } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, Select } from '@/components/ui'
import { useUsers } from '@/services/queries'
import { createUser, deleteUser, updateUser } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain'
import { cn } from '@/lib/utils'
import { useTableView, ViewNote, ViewTh } from '@/components/ui/ColumnFilter'
import { ROLES, type Role, type UserProfile } from '@qc/shared/types'


const ROLE_TONE: Record<Role, 'neutral' | 'blue' | 'violet'> = { viewer: 'neutral', inspector: 'neutral', supervisor: 'blue', admin: 'violet' }

const ROLE_HELP: Record<Role, string> = {
  viewer: 'Reads the board, History and the dashboard. Changes nothing; no chat, no notices, no administration.',
  inspector: 'Records inspections and corrects open sessions.',
  supervisor: 'Also corrects closed sessions, deletes sessions and reviews the audit log.',
  admin: 'Also manages master data, imports, users and audit purges.',
}

/** Mirrors the API's rule: 2–40 letters, digits, dots, dashes or underscores. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/

interface UserDraft {
  username: string
  name: string
  role: Role
  password: string
}

export function UsersPanel() {
  const queryClient = useQueryClient()
  const { profile } = useAuth()
  const { toast } = useApp()
  const { data: users = [], isLoading } = useUsers()
  const [creating, setCreating] = useState<UserDraft | null>(null)
  const [editing, setEditing] = useState<UserProfile | null>(null)
  const [removing, setRemoving] = useState<UserProfile | null>(null)
  const [editDraft, setEditDraft] = useState<{ username: string; name: string; role: Role; password: string }>({
    username: '',
    name: '',
    role: 'inspector',
    password: '',
  })
  const [busy, setBusy] = useState(false)

  const sorted = useMemo(
    () => [...users].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name)),
    [users],
  )
  const view = useTableView(sorted, [
    { key: 'name', value: (u) => u.name },
    { key: 'username', value: (u) => u.username },
    { key: 'role', value: (u) => u.role },
    { key: 'status', value: (u) => (u.isActive ? 'Active' : 'Deactivated') },
  ])

  async function submitCreate() {
    if (!creating) return
    const username = creating.username.trim().toLowerCase()
    if (!username || !creating.name.trim()) return toast('Username and name are required.', 'error')
    if (!USERNAME_PATTERN.test(username)) return toast('Username: 2–40 letters, digits, dots, dashes or underscores.', 'error')
    if (creating.password.length < 8) return toast('Password must be at least 8 characters.', 'error')
    setBusy(true)
    try {
      await createUser(queryClient, { username, name: creating.name.trim(), role: creating.role, password: creating.password })
      toast('Account created.', 'success')
      setCreating(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the account.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function submitEdit() {
    if (!editing) return
    const username = editDraft.username.trim().toLowerCase()
    if (!username || !editDraft.name.trim()) return toast('Username and name are required.', 'error')
    if (!USERNAME_PATTERN.test(username)) return toast('Username: 2–40 letters, digits, dots, dashes or underscores.', 'error')
    if (editDraft.password && editDraft.password.length < 8) return toast('Password must be at least 8 characters.', 'error')
    setBusy(true)
    try {
      await updateUser(queryClient, editing.id, {
        username: username !== editing.username ? username : undefined,
        name: editDraft.name.trim(),
        role: editDraft.role,
        password: editDraft.password || undefined,
      })
      toast('Account updated.', 'success')
      setEditing(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the account.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function submitRemove() {
    if (!removing) return
    setBusy(true)
    try {
      await deleteUser(queryClient, removing.id)
      toast(`${removing.name} removed — the account is signed out everywhere and "${removing.username}" is free again.`, 'success')
      setRemoving(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the account.', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(u: UserProfile) {
    setBusy(true)
    try {
      await updateUser(queryClient, u.id, { isActive: !u.isActive })
      toast(u.isActive ? `${u.name} deactivated — they are signed out everywhere.` : `${u.name} reactivated.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the account.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              <UserCog className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold">Users</h2>
              <p className="mt-0.5 text-sm text-muted">Who can sign in, and what each person may do.</p>
            </div>
          </div>
          <Button variant="primary" className="min-h-[48px]" onClick={() => setCreating({ username: '', name: '', role: 'inspector', password: '' })}>
            <UserPlus className="h-4 w-4" /> Add user
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
                <tr>
                  <ViewTh view={view} column="name" label="Name" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="username" label="Username" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="role" label="Role" className="px-3 py-2.5 font-bold" />
                  <ViewTh view={view} column="status" label="Status" className="px-3 py-2.5 font-bold" />
                  <th className="px-3 py-2.5 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {view.rows.map((u) => (
                  <tr key={u.id} className={cn('hover:bg-slate-50/70 dark:hover:bg-slate-800/40', !u.isActive && 'opacity-60')}>
                    <td className="px-3 py-2.5 font-semibold">
                      {u.name}
                      {u.id === profile?.id && <span className="ml-2 text-xs font-normal text-muted">(you)</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[13px]">{u.username}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={u.isActive ? 'green' : 'red'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(u)
                            setEditDraft({ username: u.username, name: u.name, role: u.role, password: '' })
                          }}
                          aria-label={`Edit ${u.name}`}
                          className="grid h-12 w-12 place-items-center rounded-xl text-muted transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {u.id !== profile?.id && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void toggleActive(u)}
                            aria-label={u.isActive ? `Deactivate ${u.name}` : `Reactivate ${u.name}`}
                            className="grid h-12 w-12 place-items-center rounded-xl text-muted transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                          >
                            {u.isActive ? <ShieldAlert className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                          </button>
                        )}
                        {u.id !== profile?.id && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setRemoving(u)}
                            aria-label={`Remove ${u.name}`}
                            className="grid h-12 w-12 place-items-center rounded-xl text-muted transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={creating !== null}
        onClose={() => {
          if (!busy) setCreating(null)
        }}
        title="Add user"
        icon={<UserPlus className="h-5 w-5" />}
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setCreating(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" className="min-h-[48px]" onClick={() => void submitCreate()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Create account
            </Button>
          </>
        }
      >
        {creating && (
          <div className="space-y-3">
            <Field label="Full name">
              <Input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="Mohamed Abdelrahman" />
            </Field>
            <Field label="Username" hint="What they type to sign in. Letters, digits, dots, dashes or underscores.">
              <Input
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={creating.username}
                onChange={(e) => setCreating({ ...creating, username: e.target.value })}
                placeholder="m.abdelrahman"
              />
            </Field>
            <Field label="Role" hint={ROLE_HELP[creating.role]}>
              <Select className="min-h-[48px]" value={creating.role} onChange={(e) => setCreating({ ...creating, role: e.target.value as Role })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Temporary password" hint="At least 8 characters. Ask them to change it after the first sign-in.">
              <Input type="text" autoComplete="off" value={creating.password} onChange={(e) => setCreating({ ...creating, password: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => {
          if (!busy) setEditing(null)
        }}
        title={editing ? `Edit — ${editing.name}` : 'Edit user'}
        icon={<UserCog className="h-5 w-5" />}
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" className="min-h-[48px]" onClick={() => void submitEdit()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <Field label="Full name">
              <Input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
            </Field>
            <Field label="Username" hint="What they type to sign in. Changing it does not sign them out.">
              <Input
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={editDraft.username}
                onChange={(e) => setEditDraft({ ...editDraft, username: e.target.value })}
              />
            </Field>
            <Field label="Role" hint={ROLE_HELP[editDraft.role]}>
              <Select
                className="min-h-[48px]"
                value={editDraft.role}
                disabled={editing.id === profile?.id}
                onChange={(e) => setEditDraft({ ...editDraft, role: e.target.value as Role })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reset password" hint="Leave empty to keep the current password. Setting one signs the person out everywhere.">
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input type="text" autoComplete="off" className="pl-9" value={editDraft.password} onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })} />
              </div>
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => {
          if (!busy) setRemoving(null)
        }}
        title={removing ? `Remove ${removing.name}?` : 'Remove user'}
        icon={<Trash2 className="h-5 w-5" />}
        size="sm"
        footer={
          <>
            <Button className="min-h-[48px]" onClick={() => setRemoving(null)} disabled={busy}>
              Keep the account
            </Button>
            <Button variant="danger" className="min-h-[48px]" onClick={() => void submitRemove()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Remove
            </Button>
          </>
        }
      >
        {removing && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <span className="font-semibold">{removing.name}</span> (<span className="font-mono">{removing.username}</span>) disappears from this
            list, is signed out on every device and can no longer sign in. The username is free to give to someone else. Inspections and
            audit entries they recorded keep their name. This cannot be undone.
          </p>
        )}
      </Modal>
    </div>
  )
}
