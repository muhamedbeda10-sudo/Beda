// ============================================================================
// §14 — accounts and roles. Accounts are deactivated, never deleted.
// ============================================================================

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Info, KeyRound, Loader2, Pencil, RotateCcw, ShieldAlert, UserCog, UserPlus } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, Select } from '@/components/ui'
import { useUsers } from '@/services/queries'
import { createUser, updateUser } from '@/services/mutations'
import { useAuth } from '@/store/AuthContext'
import { useApp } from '@/store/AppContext'
import { can } from '@/domain'
import { cn } from '@/lib/utils'
import { ROLES, type Role, type UserProfile } from '@qc/shared/types'


const ROLE_TONE: Record<Role, 'neutral' | 'blue' | 'violet'> = { inspector: 'neutral', supervisor: 'blue', admin: 'violet' }

const ROLE_HELP: Record<Role, string> = {
  inspector: 'Records inspections and corrects open sessions.',
  supervisor: 'Also corrects closed sessions, deletes sessions and reviews the audit log.',
  admin: 'Also manages master data, imports, users and audit purges.',
}

interface UserDraft {
  email: string
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
  const [editDraft, setEditDraft] = useState<{ name: string; role: Role; password: string }>({ name: '', role: 'inspector', password: '' })
  const [busy, setBusy] = useState(false)

  const sorted = useMemo(
    () => [...users].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name)),
    [users],
  )

  async function submitCreate() {
    if (!creating) return
    if (!creating.email.trim() || !creating.name.trim()) return toast('Email and name are required.', 'error')
    if (creating.password.length < 8) return toast('Password must be at least 8 characters.', 'error')
    setBusy(true)
    try {
      await createUser(queryClient, { email: creating.email.trim(), name: creating.name.trim(), role: creating.role, password: creating.password })
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
    if (!editDraft.name.trim()) return toast('Name is required.', 'error')
    if (editDraft.password && editDraft.password.length < 8) return toast('Password must be at least 8 characters.', 'error')
    setBusy(true)
    try {
      await updateUser(queryClient, editing.id, {
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
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Who can sign in, and what each person may do.</p>
            </div>
          </div>
          <Button variant="primary" className="min-h-[48px]" onClick={() => setCreating({ email: '', name: '', role: 'inspector', password: '' })}>
            <UserPlus className="h-4 w-4" /> Add user
          </Button>
        </div>

        <p className="flex items-start gap-2 rounded-2xl bg-brand-50 px-3 py-2.5 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Accounts are never deleted. Deactivating one signs that person out everywhere and blocks sign-in, while every inspection and audit
            entry they made keeps their name. Role changes take effect on the person's next request.
          </span>
        </p>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2.5 font-bold">Name</th>
                  <th className="px-3 py-2.5 font-bold">Email</th>
                  <th className="px-3 py-2.5 font-bold">Role</th>
                  <th className="px-3 py-2.5 font-bold">Status</th>
                  <th className="px-3 py-2.5 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sorted.map((u) => (
                  <tr key={u.id} className={cn('hover:bg-slate-50/70 dark:hover:bg-slate-800/40', !u.isActive && 'opacity-60')}>
                    <td className="px-3 py-2.5 font-semibold">
                      {u.name}
                      {u.id === profile?.id && <span className="ml-2 text-xs font-normal text-slate-400">(you)</span>}
                    </td>
                    <td className="px-3 py-2.5">{u.email}</td>
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
                            setEditDraft({ name: u.name, role: u.role, password: '' })
                          }}
                          aria-label={`Edit ${u.name}`}
                          className="grid h-12 w-12 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {u.id !== profile?.id && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void toggleActive(u)}
                            aria-label={u.isActive ? `Deactivate ${u.name}` : `Reactivate ${u.name}`}
                            className="grid h-12 w-12 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                          >
                            {u.isActive ? <ShieldAlert className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
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
            <Field label="Email">
              <Input type="email" value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} placeholder="name@factory.com" />
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
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input type="text" autoComplete="off" className="pl-9" value={editDraft.password} onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })} />
              </div>
            </Field>
          </div>
        )}
      </Modal>
    </div>
  )
}
