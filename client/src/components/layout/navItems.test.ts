import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, NAV, TOOLS_NAV, visibleNav } from './navItems'

const paths = (items: { to: string }[]) => items.map((n) => n.to)

describe('the sections each person sees', () => {
  it('has no entry for the AI assistant’s settings, for its owner or anyone: they open from the gear in its popup', () => {
    for (const owner of [true, false]) {
      expect(paths(visibleNav(ADMIN_NAV, 'admin', owner))).not.toContain('/admin/ai')
      // An owner who is not an administrator has no administration at all.
      expect(visibleNav(ADMIN_NAV, 'inspector', owner)).toEqual([])
    }
  })

  it('keeps every other entry to its capability', () => {
    expect(paths(visibleNav(ADMIN_NAV, 'admin', false))).toEqual(['/admin/configuration', '/admin/import', '/admin/users', '/admin/audit', '/admin/whats-new'])
    expect(paths(visibleNav(NAV, 'inspector', false))).toEqual(['/', '/history', '/mtc'])
    expect(paths(visibleNav(NAV, undefined, false))).toEqual(['/', '/history', '/mtc'])
  })

  it('shows the MTC tab to everyone, last: the coil register is for all to read', () => {
    for (const role of ['viewer', 'inspector', 'supervisor', 'admin'] as const) {
      expect(paths(visibleNav(NAV, role, false)).at(-1)).toBe('/mtc')
    }
  })

  it('has no tab for Automations or Follow-ups: they open from the assistant and from the bell', () => {
    for (const role of ['viewer', 'inspector', 'supervisor', 'admin'] as const) {
      expect(paths(visibleNav(NAV, role, true))).not.toContain('/automations')
      expect(paths(visibleNav(NAV, role, true))).not.toContain('/follow-ups')
    }
  })

  it('lists Coil search and New PDI in the menu for whoever records inspections, and for nobody else', () => {
    expect(TOOLS_NAV.map((n) => n.label)).toEqual(['Coil search', 'New PDI'])
    expect(paths(visibleNav(TOOLS_NAV, 'inspector', false))).toEqual(['/coils', '/pdi'])
    expect(paths(visibleNav(TOOLS_NAV, 'supervisor', false))).toEqual(['/coils', '/pdi'])
    expect(paths(visibleNav(TOOLS_NAV, 'admin', false))).toEqual(['/coils', '/pdi'])
    // A viewer reads the board; the tools record, so the menu does not offer them.
    expect(visibleNav(TOOLS_NAV, 'viewer', false)).toEqual([])
    expect(visibleNav(TOOLS_NAV, undefined, false)).toEqual([])
  })
})
