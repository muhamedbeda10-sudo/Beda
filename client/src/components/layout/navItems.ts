// The app's sections: the work an inspector does, the inspector's tools, and
// administration behind the gear. Each is shown only to someone who may use it
// — by role, or, for the AI assistant's settings, to the one person who owns
// the assistant, and for automations (§21), to the people who may create them;
// follow-ups (§21) to whoever has some, or may see everyone's.

import { BellRing, Bot, ClipboardCheck, FileText, History, LayoutDashboard, ListChecks, ScrollText, Search, SlidersHorizontal, Sparkles, Table2, UploadCloud, Users, Zap } from 'lucide-react'
import { can, type Capability } from '@qc/shared/rules'
import type { Role } from '@qc/shared/types'

export interface NavItem {
  to: string
  label: string
  icon: typeof ClipboardCheck
  end?: boolean
  needs?: Capability
  /** §20 — for the AI assistant's owner alone, whatever the role; to anyone else the entry does not exist. */
  aiOwner?: boolean
  /** §21 — for the people who may create automations (the assistant's owner, and those the owner allowed), whatever the role. */
  automations?: boolean
  /** §21 — for whoever the follow-ups page has something for (/follow-ups/counts' `visible`), whatever the role. */
  followUps?: boolean
  /** One line shown under the label in the administration menu. */
  hint?: string
}

/** The work an inspector does: centred in the bar on a desktop, in the menu on a tablet or phone. */
export const NAV: NavItem[] = [
  { to: '/access', label: 'Access', icon: Table2, needs: 'view-order-sheet' },
  { to: '/', label: 'Inspections', icon: ClipboardCheck, end: true },
  { to: '/history', label: 'History', icon: History },
  { to: '/follow-ups', label: 'Follow-ups', icon: ListChecks, followUps: true },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, needs: 'view-dashboard' },
  { to: '/automations', label: 'Automations', icon: Zap, automations: true },
]

/**
 * The tools an inspector opens from the board (its Coil search and New PDI
 * buttons), named again in the menu: on a tablet or phone the menu is where
 * someone looks for a place to go, and a button on one page is easy to miss.
 */
export const TOOLS_NAV: NavItem[] = [
  { to: '/coils', label: 'Coil search', icon: Search, needs: 'record-inspection' },
  { to: '/pdi', label: 'New PDI', icon: FileText, needs: 'record-inspection' },
]

/** Administration, behind the gear. */
export const ADMIN_NAV: NavItem[] = [
  { to: '/admin/configuration', label: 'Configuration', icon: SlidersHorizontal, needs: 'manage-admin-data', hint: 'Machines, items, defects, grades' },
  { to: '/admin/import', label: 'Data import', icon: UploadCloud, needs: 'manage-admin-data', hint: 'Production orders and coils' },
  { to: '/admin/users', label: 'Users', icon: Users, needs: 'manage-admin-data', hint: 'Accounts and roles' },
  { to: '/admin/notices', label: 'Notices', icon: BellRing, needs: 'manage-admin-data', hint: 'Targeted messages and who read them' },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, needs: 'edit-closed-session', hint: 'Who changed what, and when' },
  { to: '/admin/ai', label: 'AI assistant', icon: Bot, aiOwner: true, hint: 'Who can use it, the key, caps and usage' },
  { to: '/admin/whats-new', label: "What's new", icon: Sparkles, needs: 'manage-admin-data', hint: 'Every update, newest first' },
]

/**
 * The entries this person sees: by their role's capabilities, the AI
 * assistant's settings only for its owner, Automations only for someone who
 * may create them (/ai/me's `automations`), and Follow-ups only for someone
 * the page has something for (/follow-ups/counts' `visible`).
 */
export function visibleNav(items: readonly NavItem[], role: Role | undefined, aiOwner: boolean, automations = false, followUps = false): NavItem[] {
  return items.filter((n) => (n.aiOwner ? aiOwner : n.automations ? automations : n.followUps ? followUps : !n.needs || can(role, n.needs)))
}
