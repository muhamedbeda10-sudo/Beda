import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, NAV, visibleNav } from './navItems'

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

  it('lists Automations for someone who may create them, whatever the role, and for nobody else', () => {
    expect(paths(visibleNav(NAV, 'inspector', false, true))).toEqual(['/', '/history', '/automations'])
    expect(paths(visibleNav(NAV, 'admin', false, false))).not.toContain('/automations')
    // Owning the assistant is not what shows it: /ai/me's `automations` is (true for an owner who has the assistant).
    expect(paths(visibleNav(NAV, 'admin', true))).not.toContain('/automations')
  })

  it('lists Follow-ups for whoever the page has something for, whatever the role, beside History', () => {
    expect(paths(visibleNav(NAV, 'inspector', false, false, true))).toEqual(['/', '/history', '/follow-ups'])
    expect(paths(visibleNav(NAV, 'admin', false, false, false))).not.toContain('/follow-ups')
    expect(paths(visibleNav(NAV, 'inspector', false, true, true))).toEqual(['/', '/history', '/follow-ups', '/automations'])
  })
})
