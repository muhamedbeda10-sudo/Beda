// ============================================================================
// §14 — the Users screen's rules about permissions, as the server holds them:
// ADMIN+ is changed by its owner alone; nobody changes their own role or
// permissions; one manages only an account whose permissions one holds, and
// gives only what one holds. The server refuses anything else; these decide
// what the screen offers, so nobody is offered what would be refused.
// ============================================================================

import { PERMISSION_IDS, permissionsBeyond, type Permission, type PermissionOverride } from '@qc/shared/permissions'
import type { ManagedUser, Role } from '@qc/shared/types'

/** The person at the screen: what they hold, and whether they are ADMIN+. */
export interface Editor {
  id: string
  role: Role
  adminPlus: boolean
  held: readonly Permission[]
}

/** How a person stands on one permission: as their role says (on or off), or by an override of their own. */
export type PermissionState = 'role-on' | 'role-off' | 'given' | 'taken'

export function permissionState(rolePermissions: readonly Permission[], overrides: readonly PermissionOverride[], p: Permission): PermissionState {
  const o = overrides.find((x) => x.permission === p)
  if (o) return o.granted ? 'given' : 'taken'
  return rolePermissions.includes(p) ? 'role-on' : 'role-off'
}

export const isOn = (s: PermissionState) => s === 'role-on' || s === 'given'

/** Why an account cannot be changed by this editor, or null when it can. */
export function manageBlock(editor: Editor, target: Pick<ManagedUser, 'id' | 'adminPlus' | 'permissions'>): string | null {
  if (target.adminPlus && target.id !== editor.id) return 'The ADMIN+ account is changed by its owner alone.'
  if (!editor.adminPlus && permissionsBeyond(editor.held, target.permissions).length > 0) return 'They hold permissions you do not: an administrator above you changes them.'
  return null
}

/** Why the editor cannot give a person their own permissions, or null when they can. */
export function permissionsBlock(editor: Editor, target: Pick<ManagedUser, 'id' | 'adminPlus' | 'permissions'>): string | null {
  if (target.id === editor.id) return 'Nobody changes their own permissions.'
  if (target.adminPlus) return 'ADMIN+ holds every permission, always.'
  return manageBlock(editor, target)
}

/** Whether the editor may turn a permission on (one gives only what one holds); turning one off is always theirs. */
export const mayGive = (editor: Editor, p: Permission): boolean => editor.adminPlus || editor.held.includes(p)

/** The roles whose sets this editor may change: not the administrators' (ADMIN+'s alone), not their own. */
export function editableRoles(editor: Pick<Editor, 'role' | 'adminPlus'>, roles: readonly Role[]): Role[] {
  return editor.adminPlus ? [...roles] : roles.filter((r) => r !== 'admin' && r !== editor.role)
}

/** A person's own differences, in a few characters: "+2 −1"; empty when they hold exactly their role's set. */
export function overridesSummary(overrides: readonly PermissionOverride[]): string {
  const given = overrides.filter((o) => o.granted).length
  const taken = overrides.length - given
  return [given ? `+${given}` : '', taken ? `−${taken}` : ''].filter(Boolean).join(' ')
}

/** A set in the catalog's order, each once. */
export const ordered = (list: Iterable<Permission>): Permission[] => {
  const set = new Set(list)
  return PERMISSION_IDS.filter((p) => set.has(p))
}
