import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, NAV, TOOLS_NAV, visibleNav } from './navItems'

const paths = (items: { to: string }[]) => items.map((n) => n.to)

describe('the sections each person sees', () => {
  it('lists the AI assistant’s settings for its owner alone, whatever the role', () => {
    expect(paths(visibleNav(ADMIN_NAV, 'admin', true))).toContain('/admin/ai')
    // Another administrator does not even see that it exists.
    expect(paths(visibleNav(ADMIN_NAV, 'admin', false))).not.toContain('/admin/ai')
    // An owner who is not an administrator sees that one entry, and no other administration.
    expect(paths(visibleNav(ADMIN_NAV, 'inspector', true))).toEqual(['/admin/ai'])
    expect(visibleNav(ADMIN_NAV, 'inspector', false)).toEqual([])
  })

  it('keeps every other entry to its capability', () => {
    expect(paths(visibleNav(ADMIN_NAV, 'admin', false))).toEqual(['/admin/configuration', '/admin/import', '/admin/users', '/admin/notices', '/admin/audit', '/admin/whats-new'])
    expect(paths(visibleNav(NAV, 'inspector', false))).toEqual(['/', '/history'])
    expect(paths(visibleNav(NAV, undefined, false))).toEqual(['/', '/history'])
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
