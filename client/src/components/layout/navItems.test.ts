import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_IDS, type Permission } from '@qc/shared/permissions'
import { ADMIN_NAV, NAV, TOOLS_NAV, visibleNav } from './navItems'

const paths = (items: { to: string }[]) => items.map((n) => n.to)
const role = DEFAULT_ROLE_PERMISSIONS

describe('the sections each person sees', () => {
  it('has no entry for the AI assistant’s settings, for its owner or anyone: they open from the gear in its popup', () => {
    for (const owner of [true, false]) {
      expect(paths(visibleNav(ADMIN_NAV, role.admin, owner))).not.toContain('/admin/ai')
      // An owner who may open no administration screen has no administration at all.
      expect(visibleNav(ADMIN_NAV, role.inspector, owner)).toEqual([])
    }
  })

  it('keeps every entry to its permission (§14)', () => {
    expect(paths(visibleNav(ADMIN_NAV, PERMISSION_IDS, false))).toEqual(['/admin/configuration', '/admin/import', '/admin/users', '/admin/audit', '/admin/whats-new'])
    expect(paths(visibleNav(ADMIN_NAV, role.supervisor, false))).toEqual(['/admin/audit'])
    expect(paths(visibleNav(NAV, role.inspector, false))).toEqual(['/', '/history', '/mtc'])
    expect(paths(visibleNav(NAV, role.viewer, false))).toEqual(['/access', '/', '/history', '/dashboard', '/mtc'])
    expect(visibleNav(NAV, [], false)).toEqual([])
  })

  it('shows a person exactly the screens they hold, their own differences included', () => {
    const mine: Permission[] = ['view-mtc', 'view-dashboard', 'import-data']
    expect(paths(visibleNav(NAV, mine, false))).toEqual(['/dashboard', '/mtc'])
    expect(paths(visibleNav(ADMIN_NAV, mine, false))).toEqual(['/admin/import'])
  })

  it('has no tab for Automations or Follow-ups: they open from the assistant and from the bell', () => {
    expect(paths(visibleNav(NAV, PERMISSION_IDS, true))).not.toContain('/automations')
    expect(paths(visibleNav(NAV, PERMISSION_IDS, true))).not.toContain('/follow-ups')
  })

  it('lists Coil search and New PDI in the menu for whoever may use them, and for nobody else', () => {
    expect(TOOLS_NAV.map((n) => n.label)).toEqual(['Coil search', 'New PDI'])
    for (const r of ['inspector', 'supervisor', 'admin'] as const) expect(paths(visibleNav(TOOLS_NAV, role[r], false)), r).toEqual(['/coils', '/pdi'])
    // A viewer reads the board; the tools record, so the menu does not offer them.
    expect(visibleNav(TOOLS_NAV, role.viewer, false)).toEqual([])
    expect(paths(visibleNav(TOOLS_NAV, ['view-coil-search'], false))).toEqual(['/coils'])
  })
})
