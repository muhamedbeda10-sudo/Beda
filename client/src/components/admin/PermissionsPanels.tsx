// ============================================================================
// §14 — what each role and each person may open and do, on the Users screen.
//
//   • A person's permissions: their role's set, each permission ticked or
//     not; a tick changed from the role's is that person's own override
//     ("Given", "Taken away"), kept until put back as the role has it. Their
//     role's later changes reach them in every other permission.
//   • Roles: each role's set, as a table of permissions by role. ADMIN+ holds
//     every one, always; the administrators' set is ADMIN+'s alone to change.
//
// Nobody is offered what the server would refuse: one gives only what one
// holds, and changes neither oneself nor ADMIN+.
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Crown, Loader2, Lock, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { ADMIN_PLUS, PERMISSIONS, PERMISSION_GROUPS, PERMISSION_INFO, overridesFor, type Permission } from '@qc/shared/permissions'
import { ROLES, type ManagedUser, type Role } from '@qc/shared/types'
import { Badge, Button, Card, Modal } from '@/components/ui'
import { ScrollX } from '@/components/ui/ScrollX'
import { useRolePermissions } from '@/services/queries'
import { saveRolePermissions, saveUserPermissions } from '@/services/mutations'
import { useApp } from '@/store/AppContext'
import { cn } from '@/lib/utils'
import { isOn, mayGive, ordered, permissionState, type Editor, type PermissionState } from './permissions'

const CHECK = 'h-5 w-5 shrink-0 cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-50 touch:h-6 touch:w-6'

const STATE_BADGE: Record<PermissionState, { tone: 'neutral' | 'green' | 'red'; text: string } | null> = {
  'role-on': null,
  'role-off': null,
  given: { tone: 'green', text: 'Given' },
  taken: { tone: 'red', text: 'Taken away' },
}

export const roleName = (r: Role) => r.charAt(0).toUpperCase() + r.slice(1)

// ---- One person ----------------------------------------------------------------------

export function PersonPermissionsModal({ user, editor, onClose }: { user: ManagedUser | null; editor: Editor; onClose: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { data: roles } = useRolePermissions()
  const [wanted, setWanted] = useState<Permission[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => setWanted(user ? [...user.permissions] : []), [user])
  if (!user) return null
  const rolePermissions = roles?.roles[user.role] ?? []
  const overrides = overridesFor(rolePermissions, wanted)
  const saved = overridesFor(rolePermissions, user.permissions)
  const dirty = JSON.stringify(overrides) !== JSON.stringify(saved)

  const toggle = (p: Permission, on: boolean) => setWanted((w) => ordered(on ? [...w, p] : w.filter((x) => x !== p)))

  const save = async () => {
    setBusy(true)
    try {
      await saveUserPermissions(qc, user.id, { overrides })
      toast(`${user.name}'s permissions saved. They apply at once.`, 'success')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the permissions.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose()
      }}
      size="lg"
      title={`Permissions — ${user.name}`}
      icon={<ShieldCheck className="h-5 w-5" />}
      footer={
        <>
          <Button className="min-h-[48px]" onClick={() => setWanted(ordered(rolePermissions))} disabled={busy || overrides.length === 0}>
            <RotateCcw className="h-4 w-4" /> As the role
          </Button>
          <Button variant="primary" className="min-h-[48px]" onClick={() => void save()} disabled={busy || !dirty || !roles}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        {/^[aeiou]/.test(user.role) ? 'An' : 'A'} {user.role} by role. Tick or untick to differ from the role for {user.name} alone; everything else follows the {user.role} role,
        whatever it is changed to later. Screens taken away are refused by the server too, not only hidden.
      </p>
      {!roles ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {PERMISSION_GROUPS.map((g) => (
            <section key={g.id}>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">{g.name}</h3>
              <ul className="divide-y divide-slate-100 rounded-2xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
                {PERMISSIONS.filter((p) => p.group === g.id).map((p) => {
                  const state = permissionState(rolePermissions, overrides, p.id)
                  const on = isOn(state)
                  const locked = busy || (!on && !mayGive(editor, p.id))
                  const badge = STATE_BADGE[state]
                  const needs = p.needs && !wanted.includes(p.needs) ? p.needs : null
                  return (
                    <li key={p.id}>
                      <label className={cn('flex min-h-[52px] items-start gap-3 px-3 py-2.5', locked ? 'cursor-not-allowed' : 'cursor-pointer')}>
                        <input type="checkbox" className={cn(CHECK, 'mt-0.5')} checked={on} disabled={locked} onChange={(e) => toggle(p.id, e.target.checked)} aria-label={p.name} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                            {p.name}
                            {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
                          </span>
                          <span className="block text-xs text-muted">{p.help}</span>
                          {on && needs && <span className="block text-xs font-medium text-amber-700 dark:text-amber-300">Needs the {PERMISSION_INFO[needs].name} screen to be reached.</span>}
                          {!on && !mayGive(editor, p.id) && <span className="block text-xs text-muted">You do not hold this, so you cannot give it.</span>}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ---- The roles -------------------------------------------------------------------------

export function RolesPanel({ editor }: { editor: Editor }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const { data, isLoading } = useRolePermissions()
  const [draft, setDraft] = useState<Record<Role, Permission[]> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (data) setDraft(data.roles)
  }, [data])
  const changed = useMemo(() => (data && draft ? ROLES.filter((r) => draft[r].join() !== data.roles[r].join()) : []), [data, draft])

  if (isLoading || !data || !draft) {
    return (
      <Card className="flex items-center gap-2 p-6 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </Card>
    )
  }

  const toggle = (role: Role, p: Permission, on: boolean) =>
    setDraft((d) => (d ? { ...d, [role]: ordered(on ? [...d[role], p] : d[role].filter((x) => x !== p)) } : d))

  const save = async () => {
    setBusy(true)
    try {
      for (const role of changed) await saveRolePermissions(qc, role, { permissions: draft[role] })
      toast(`${changed.map(roleName).join(', ')}: saved. Everyone of the role has it at once, less their own differences.`, 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the roles.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          What each role may open and do. A change reaches everyone of the role at once, except where a person has their own difference. {ADMIN_PLUS} holds
          everything, always{editor.adminPlus ? '' : '; the administrators’ set and your own role’s are changed by others'}.
        </p>
        <div className="flex gap-2">
          <Button className="min-h-[44px]" onClick={() => setDraft(data.roles)} disabled={busy || changed.length === 0}>
            <RotateCcw className="h-4 w-4" /> Undo
          </Button>
          <Button variant="primary" className="min-h-[44px]" onClick={() => void save()} disabled={busy || changed.length === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save{changed.length > 0 ? ` (${changed.length})` : ''}
          </Button>
        </div>
      </div>
      <ScrollX className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800" innerClassName="rounded-2xl" shadows="start">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-muted dark:bg-slate-800/60">
            <tr>
              <th className="sticky left-0 z-[1] bg-slate-50 px-3 py-2.5 text-left font-bold dark:bg-slate-800">Permission</th>
              {ROLES.map((r) => (
                <th key={r} className="w-24 px-2 py-2.5 text-center font-bold">
                  <span className="inline-flex items-center gap-1">
                    {roleName(r)}
                    {!data.editable.includes(r) && <Lock className="h-3 w-3" aria-label="Not yours to change" />}
                  </span>
                </th>
              ))}
              <th className="w-24 px-2 py-2.5 text-center font-bold">
                <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-300">
                  <Crown className="h-3.5 w-3.5" /> {ADMIN_PLUS}
                </span>
              </th>
            </tr>
          </thead>
          {PERMISSION_GROUPS.map((g) => (
            <tbody key={g.id} className="divide-y divide-slate-100 dark:divide-slate-800">
              <tr className="bg-slate-50/60 dark:bg-slate-800/30">
                <th colSpan={ROLES.length + 2} className="sticky left-0 px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-[0.14em] text-muted">
                  {g.name}
                </th>
              </tr>
              {PERMISSIONS.filter((p) => p.group === g.id).map((p) => (
                <tr key={p.id}>
                  <td className="sticky left-0 z-[1] bg-white px-3 py-2 dark:bg-slate-900" data-tip={p.help}>
                    <span className="block font-semibold">{p.name}</span>
                    <span className="block max-w-xs text-xs text-muted">{p.help}</span>
                  </td>
                  {ROLES.map((r) => {
                    const on = draft[r].includes(p.id)
                    const locked = busy || !data.editable.includes(r) || (!on && !mayGive(editor, p.id))
                    const changedHere = on !== data.roles[r].includes(p.id)
                    return (
                      <td key={r} className={cn('px-2 py-2 text-center', changedHere && 'bg-amber-50 dark:bg-amber-500/10')}>
                        <input type="checkbox" className={CHECK} checked={on} disabled={locked} onChange={(e) => toggle(r, p.id, e.target.checked)} aria-label={`${roleName(r)}: ${p.name}`} />
                      </td>
                    )
                  })}
                  <td className="px-2 py-2 text-center">
                    <input type="checkbox" className={CHECK} checked disabled aria-label={`${ADMIN_PLUS}: ${p.name}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </ScrollX>
    </Card>
  )
}
