// The app's sections: the work an inspector does, the inspector's tools, and
// administration behind the gear. Each is shown only to someone who may open
// it (§14: their role's permissions with their own overrides — the server
// refuses the screen's data to anyone else), or, for the AI assistant's
// settings, to the one person who owns the assistant. Automations (§21) open from the assistant's header, and
// follow-ups (§21) from the bell, and notices (§16) from their own button beside it: none is a tab here. Reports —
// the saved reports shared with a person — is a tab for whoever has one shared with them, whatever their role.

import { ChartGantt, ClipboardCheck, FileChartColumn, FileCheck2, FileText, History, LayoutDashboard, ScrollText, Search, SlidersHorizontal, Sparkles, Table2, UploadCloud, Users } from 'lucide-react'
import { can, type Permission } from '@qc/shared/permissions'

export interface NavItem {
  to: string
  label: string
  icon: typeof ClipboardCheck
  end?: boolean
  needs?: Permission
  /** §20 — for the AI assistant's owner alone, whatever the role; to anyone else the entry does not exist. */
  aiOwner?: boolean
  /** One line shown under the label in the administration menu. */
  hint?: string
  /** For whoever has a saved report shared with them, whatever their permissions (shared/reportShares.ts). */
  sharedReports?: boolean
}

/** The work an inspector does: centred in the bar on a desktop, in the menu on a tablet or phone. */
export const NAV: NavItem[] = [
  { to: '/access', label: 'Access', icon: Table2, needs: 'view-order-sheet' },
  { to: '/', label: 'Inspections', icon: ClipboardCheck, end: true, needs: 'view-inspections' },
  { to: '/history', label: 'History', icon: History, needs: 'view-history' },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, needs: 'view-dashboard' },
  // §25 — planning, a trial: its parts are icons inside the tab.
  { to: '/planning', label: 'Planning', icon: ChartGantt, needs: 'view-planning' },
  // The material registers; uploading a mill test certificate into them is set in the AI settings (ai_access.mtc).
  { to: '/mtc', label: 'MTC', icon: FileCheck2, needs: 'view-mtc' },
  // The saved reports shared with the person: there once one is, gone once none is.
  { to: '/reports', label: 'Reports', icon: FileChartColumn, sharedReports: true },
]

/**
 * The tools an inspector opens from the board (its Coil search and New PDI
 * buttons), named again in the menu: on a tablet or phone the menu is where
 * someone looks for a place to go, and a button on one page is easy to miss.
 */
export const TOOLS_NAV: NavItem[] = [
  { to: '/coils', label: 'Coil search', icon: Search, needs: 'view-coil-search' },
  { to: '/pdi', label: 'New PDI', icon: FileText, needs: 'record-inspection' },
]

/** Administration, behind the gear. */
export const ADMIN_NAV: NavItem[] = [
  { to: '/admin/configuration', label: 'Configuration', icon: SlidersHorizontal, needs: 'manage-configuration', hint: 'Machines, items, defects, grades' },
  { to: '/admin/import', label: 'Data import', icon: UploadCloud, needs: 'import-data', hint: 'Production orders and coils' },
  { to: '/admin/users', label: 'Users', icon: Users, needs: 'manage-users', hint: 'Accounts, roles and permissions' },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, needs: 'view-audit-log', hint: 'Who changed what, and when' },
  { to: '/admin/whats-new', label: "What's new", icon: Sparkles, needs: 'view-release-notes', hint: 'Every update, newest first' },
]

/**
 * The entries this person sees: by their permissions, the AI assistant's settings only for its owner, and Reports
 * only while a report is shared with them.
 */
export function visibleNav(items: readonly NavItem[], permissions: readonly Permission[], aiOwner: boolean, sharedReports = false): NavItem[] {
  return items.filter((n) => (n.aiOwner ? aiOwner : n.sharedReports ? sharedReports : !n.needs || can(permissions, n.needs)))
}
