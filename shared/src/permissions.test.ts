import { describe, expect, it } from 'vitest'
import { ROLES } from './types'
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_IDS,
  PERMISSION_INFO,
  SCREEN_PATHS,
  can,
  effectivePermissions,
  homePath,
  isPermission,
  overridesFor,
  permissionsBeyond,
  type Permission,
} from './permissions'

describe('§14 the permission catalog', () => {
  it('describes every permission once, in a known group, and every screen has a path', () => {
    expect(PERMISSIONS.map((p) => p.id)).toEqual([...PERMISSION_IDS])
    for (const p of PERMISSIONS) {
      expect(PERMISSION_GROUPS.some((g) => g.id === p.group), p.id).toBe(true)
      expect(p.name.length, p.id).toBeGreaterThan(0)
      if (p.needs) expect(PERMISSION_INFO[p.needs].kind, p.id).toBe('screen')
    }
    const screens = PERMISSIONS.filter((p) => p.kind === 'screen').map((p) => p.id)
    expect(SCREEN_PATHS.map((s) => s.permission)).toEqual(screens)
    expect(isPermission('manage-users')).toBe(true)
    expect(isPermission('manage-admin-data')).toBe(false)
    expect(isPermission(3)).toBe(false)
  })

  it('starts each role where it was: a viewer reads, an inspector records, a supervisor corrects, an administrator does everything', () => {
    const role = (r: (typeof ROLES)[number]) => DEFAULT_ROLE_PERMISSIONS[r]
    expect(role('admin')).toEqual([...PERMISSION_IDS])
    for (const p of ['record-inspection', 'edit-open-session', 'edit-closed-session', 'use-chat', 'read-notices', 'export-records', 'view-coil-search'] as const) {
      expect(can(role('viewer'), p), p).toBe(false)
    }
    expect(can(role('viewer'), 'view-dashboard')).toBe(true)
    expect(can(role('viewer'), 'view-order-sheet')).toBe(true)
    expect(can(role('inspector'), 'record-inspection')).toBe(true)
    expect(can(role('inspector'), 'edit-closed-session')).toBe(false)
    expect(can(role('inspector'), 'view-order-sheet')).toBe(false)
    expect(can(role('supervisor'), 'edit-closed-session')).toBe(true)
    expect(can(role('supervisor'), 'view-audit-log')).toBe(true)
    expect(can(role('supervisor'), 'purge-audit-logs')).toBe(false)
    expect(can(role('supervisor'), 'delete-session')).toBe(false)
    expect(can(role('supervisor'), 'manage-users')).toBe(false)
    for (const r of ROLES) for (const p of DEFAULT_ROLE_PERMISSIONS[r]) expect(isPermission(p), `${r} ${p}`).toBe(true)
  })
})

describe('§14 a person’s permissions', () => {
  const inspector = DEFAULT_ROLE_PERMISSIONS.inspector

  it('are their role’s, with what was given added and what was taken away removed', () => {
    const held = effectivePermissions(inspector, [
      { permission: 'view-dashboard', granted: true },
      { permission: 'use-chat', granted: false },
    ])
    expect(held).toContain('view-dashboard')
    expect(held).not.toContain('use-chat')
    expect(held).toContain('record-inspection')
    // In the catalog's order, each once.
    expect(held).toEqual(PERMISSION_IDS.filter((p) => held.includes(p)))
    expect(effectivePermissions(inspector, [{ permission: 'record-inspection', granted: true }])).toEqual(effectivePermissions(inspector, []))
  })

  it('are everything for ADMIN+, whatever their role or overrides say', () => {
    expect(effectivePermissions([], [{ permission: 'manage-users', granted: false }], true)).toEqual([...PERMISSION_IDS])
  })

  it('keeps only the differences from the role, so the rest follows the role', () => {
    const wanted: Permission[] = [...inspector.filter((p) => p !== 'use-chat'), 'view-dashboard']
    const overrides = overridesFor(inspector, wanted)
    expect(overrides).toEqual([
      { permission: 'view-dashboard', granted: true },
      { permission: 'use-chat', granted: false },
    ])
    expect(effectivePermissions(inspector, overrides)).toEqual(PERMISSION_IDS.filter((p) => wanted.includes(p)))
    expect(overridesFor(inspector, inspector)).toEqual([])
  })

  it('names what an editor would give without holding it', () => {
    expect(permissionsBeyond(DEFAULT_ROLE_PERMISSIONS.supervisor, ['view-history', 'manage-users', 'purge-audit-logs'])).toEqual(['manage-users', 'purge-audit-logs'])
    expect(permissionsBeyond(PERMISSION_IDS, ['manage-users'])).toEqual([])
  })

  it('lands a person on the first screen they may open', () => {
    expect(homePath(DEFAULT_ROLE_PERMISSIONS.inspector)).toBe('/')
    expect(homePath(['view-mtc', 'view-history'])).toBe('/history')
    expect(homePath(['record-inspection'])).toBeNull()
  })

  it('answers no for nobody, and reads a set or a list alike', () => {
    expect(can(undefined, 'view-history')).toBe(false)
    expect(can(new Set<Permission>(['view-history']), 'view-history')).toBe(true)
    expect(can(['view-history'], 'view-mtc')).toBe(false)
  })
})
