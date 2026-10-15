import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_IDS } from '@qc/shared/permissions'
import { ROLES } from '@qc/shared/types'
import { editableRoles, isOn, manageBlock, mayGive, ordered, overridesSummary, permissionState, permissionsBlock, type Editor } from './permissions'

const admin: Editor = { id: 'a', role: 'admin', adminPlus: false, held: DEFAULT_ROLE_PERMISSIONS.admin }
const owner: Editor = { id: 'o', role: 'admin', adminPlus: true, held: PERMISSION_IDS }
const sup: Editor = { id: 's', role: 'supervisor', adminPlus: false, held: [...DEFAULT_ROLE_PERMISSIONS.supervisor, 'manage-users'] }
const person = (id: string, permissions = DEFAULT_ROLE_PERMISSIONS.inspector, adminPlus = false) => ({ id, adminPlus, permissions: [...permissions] })

describe('§14 a person’s standing on each permission', () => {
  it('is the role’s unless they have a difference of their own', () => {
    const role = DEFAULT_ROLE_PERMISSIONS.inspector
    const overrides = [
      { permission: 'view-dashboard' as const, granted: true },
      { permission: 'use-chat' as const, granted: false },
    ]
    expect(permissionState(role, overrides, 'view-dashboard')).toBe('given')
    expect(permissionState(role, overrides, 'use-chat')).toBe('taken')
    expect(permissionState(role, overrides, 'record-inspection')).toBe('role-on')
    expect(permissionState(role, overrides, 'manage-users')).toBe('role-off')
    expect([isOn('given'), isOn('role-on'), isOn('taken'), isOn('role-off')]).toEqual([true, true, false, false])
    expect(overridesSummary(overrides)).toBe('+1 −1')
    expect(overridesSummary([])).toBe('')
    expect(ordered(['use-chat', 'view-inspections', 'use-chat'])).toEqual(['view-inspections', 'use-chat'])
  })
})

describe('§14 what the screen offers an editor, as the server allows it', () => {
  it('never offers the ADMIN+ account to anyone but its owner, nor anyone’s own permissions', () => {
    expect(manageBlock(admin, person('o', PERMISSION_IDS, true))).toBe('The ADMIN+ account is changed by its owner alone.')
    expect(manageBlock(owner, person('o', PERMISSION_IDS, true))).toBeNull()
    expect(permissionsBlock(owner, person('o', PERMISSION_IDS, true))).toBe('Nobody changes their own permissions.')
    expect(permissionsBlock(admin, person('i'))).toBeNull()
  })

  it('offers an account only to someone holding all it holds, and a permission only to someone holding it', () => {
    expect(manageBlock(sup, person('i'))).toBeNull()
    expect(manageBlock(sup, person('x', DEFAULT_ROLE_PERMISSIONS.admin))).toMatch(/permissions you do not/)
    expect(mayGive(sup, 'export-records')).toBe(true)
    expect(mayGive(sup, 'delete-session')).toBe(false)
    expect(mayGive(owner, 'delete-session')).toBe(true)
  })

  it('offers the administrators’ set to ADMIN+ alone, and nobody their own role’s', () => {
    expect(editableRoles(owner, ROLES)).toEqual(['viewer', 'inspector', 'supervisor', 'admin'])
    expect(editableRoles(admin, ROLES)).toEqual(['viewer', 'inspector', 'supervisor'])
    expect(editableRoles(sup, ROLES)).toEqual(['viewer', 'inspector'])
  })
})
