// The app's sections: the work an inspector does, the inspector's tools, and
// administration behind the gear. Each is shown only to someone who may use it
// — by role, or, for the AI assistant's settings, to the one person who owns
// the assistant. Automations (§21) open from the assistant's header, and
// follow-ups (§21) from the bell, beside the notices: neither is a tab here.

import { ClipboardCheck, FileText, History, LayoutDashboard, ScrollText, Search, SlidersHorizontal, Sparkles, Table2, UploadCloud, Users } from 'lucide-react'
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
  /** One line shown under the label in the administration menu. */
  hint?: string
}

/** The work an inspector does: centred in the bar on a desktop, in the menu on a tablet or phone. */
export const NAV: NavItem[] = [
  { to: '/access', label: 'Access', icon: Table2, needs: 'view-order-sheet' },
  { to: '/', label: 'Inspections', icon: ClipboardCheck, end: true },
  { to: '/history', label: 'History', icon: History },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, needs: 'view-dashboard' },
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
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, needs: 'edit-closed-session', hint: 'Who changed what, and when' },
  { to: '/admin/whats-new', label: "What's new", icon: Sparkles, needs: 'manage-admin-data', hint: 'Every update, newest first' },
]

/** The entries this person sees: by their role's capabilities, and the AI assistant's settings only for its owner. */
export function visibleNav(items: readonly NavItem[], role: Role | undefined, aiOwner: boolean): NavItem[] {
  return items.filter((n) => (n.aiOwner ? aiOwner : !n.needs || can(role, n.needs)))
}
