// ============================================================================
// §14 — Permissions. What a person may open (a screen) and do (an action) is
// a set of permissions:
//
//   • each role has its set, which administrators can change (the defaults
//     below are where a new installation starts);
//   • a person can be given a permission their role lacks, or have one of
//     their role's taken away (an override, kept per person);
//   • ADMIN+ — the AI assistant's owner, one account — holds every
//     permission, always; nobody else can change that account, its role, its
//     permissions, its password, or remove it.
//
// A screen permission is enforced by the server on every endpoint that
// screen reads, not only by hiding it: a person without it cannot reach its
// data by another way. The server reads a person's permissions again on
// every request, so a change takes effect at once.
//
// Ids are stored in the database (permissions, role_permissions,
// user_permissions): adding one needs a migration that inserts it too.
// ============================================================================

import type { Role } from './types'

/** The permissions, by id. Screens first, in the order of the bar. */
export const PERMISSION_IDS = [
  // ---- Screens -----------------------------------------------------------------
  'view-inspections',
  'view-history',
  'view-order-sheet',
  'view-dashboard',
  'view-mtc',
  'view-coil-search',
  'use-chat',
  'manage-configuration',
  'import-data',
  'manage-users',
  'view-audit-log',
  'manage-notices',
  'view-release-notes',
  // ---- Inspections -----------------------------------------------------------------
  'record-inspection',
  'edit-open-session',
  'edit-closed-session',
  'view-all-sessions',
  'delete-session',
  'delete-sample',
  'delete-note',
  // ---- Records and reports ---------------------------------------------------------
  'export-records',
  'view-inspector-ranking',
  'view-all-follow-ups',
  'purge-audit-logs',
  // ---- Communication -------------------------------------------------------------
  'read-notices',
  'manage-chat',
] as const

export type Permission = (typeof PERMISSION_IDS)[number]

export const isPermission = (v: unknown): v is Permission => typeof v === 'string' && (PERMISSION_IDS as readonly string[]).includes(v)

export type PermissionGroup = 'screens' | 'inspections' | 'records' | 'communication'

export const PERMISSION_GROUPS: readonly { id: PermissionGroup; name: string }[] = [
  { id: 'screens', name: 'Screens' },
  { id: 'inspections', name: 'Inspections' },
  { id: 'records', name: 'Records and reports' },
  { id: 'communication', name: 'Communication' },
]

export interface PermissionInfo {
  id: Permission
  group: PermissionGroup
  /** A screen opens a page or tab; an action is something done on one. */
  kind: 'screen' | 'action'
  name: string
  /** What it allows, in a sentence. */
  help: string
  /** A screen this action is done on: without it, the action cannot be reached. */
  needs?: Permission
}

export const PERMISSIONS: readonly PermissionInfo[] = [
  { id: 'view-inspections', group: 'screens', kind: 'screen', name: 'Inspections', help: 'The board of sessions in progress, with their samples and holds.' },
  { id: 'view-history', group: 'screens', kind: 'screen', name: 'History', help: 'Every session and PDI, with their samples, measurements, defects and photos.' },
  { id: 'view-order-sheet', group: 'screens', kind: 'screen', name: 'Access', help: 'The ERP’s order sheet as a table.' },
  { id: 'view-dashboard', group: 'screens', kind: 'screen', name: 'Dashboard', help: 'The quality KPIs, trends and insights.' },
  { id: 'view-mtc', group: 'screens', kind: 'screen', name: 'MTC', help: 'The coil, welding wire and mesh wire registers. Uploading certificates is set in the AI settings.' },
  { id: 'view-coil-search', group: 'screens', kind: 'screen', name: 'Coil search', help: 'A coil’s samples, orders and customers.' },
  { id: 'use-chat', group: 'screens', kind: 'screen', name: 'Chat', help: 'Read and write in the team chat.' },
  {
    id: 'manage-configuration',
    group: 'screens',
    kind: 'screen',
    name: 'Configuration',
    help: 'Machines, item dimensions, reference images, machine defects, grade mappings, PT consumables, work instructions, KPI targets and the dashboard’s layout.',
  },
  { id: 'import-data', group: 'screens', kind: 'screen', name: 'Data import', help: 'Import production orders, coils and the production record; clear orders; the Access sync.' },
  { id: 'manage-users', group: 'screens', kind: 'screen', name: 'Users and permissions', help: 'Add, change and remove accounts; set what each role and each person may open and do.' },
  { id: 'view-audit-log', group: 'screens', kind: 'screen', name: 'Audit log', help: 'Who changed what, and when.' },
  { id: 'manage-notices', group: 'screens', kind: 'screen', name: 'Notices', help: 'Write notices, choose who receives them, withdraw them, and see who acknowledged.' },
  { id: 'view-release-notes', group: 'screens', kind: 'screen', name: 'What’s new', help: 'The application’s release notes.' },

  { id: 'record-inspection', group: 'inspections', kind: 'action', name: 'Record inspections', help: 'Start sessions, record samples and photos, and make PDIs.' },
  { id: 'edit-open-session', group: 'inspections', kind: 'action', name: 'Correct open sessions', help: 'Correct anyone’s samples and quantities while the session is open.' },
  { id: 'edit-closed-session', group: 'inspections', kind: 'action', name: 'Correct and reopen closed sessions', help: 'Correct samples and quantities after closing, and reopen a session.' },
  { id: 'view-all-sessions', group: 'inspections', kind: 'action', name: 'Discard anyone’s empty session', help: 'Discard a session with no samples that someone else started.' },
  { id: 'delete-session', group: 'inspections', kind: 'action', name: 'Delete sessions', help: 'Mark a session deleted, from History.', needs: 'view-history' },
  { id: 'delete-sample', group: 'inspections', kind: 'action', name: 'Delete samples', help: 'Mark a sample deleted.' },
  { id: 'delete-note', group: 'inspections', kind: 'action', name: 'Delete order notes', help: 'Mark a note on an order deleted.' },

  { id: 'export-records', group: 'records', kind: 'action', name: 'Export to Excel', help: 'Export History’s sessions, samples, measurements, defects and PDIs.', needs: 'view-history' },
  { id: 'view-inspector-ranking', group: 'records', kind: 'action', name: 'Inspectors’ ranking', help: 'The dashboard’s Inspectors tab: how each inspector is scored and placed.', needs: 'view-dashboard' },
  { id: 'view-all-follow-ups', group: 'records', kind: 'action', name: 'Everyone’s follow-ups', help: 'See and reassign every follow-up, not only one’s own.' },
  { id: 'purge-audit-logs', group: 'records', kind: 'action', name: 'Purge the audit log', help: 'Remove old entries from the audit log.', needs: 'view-audit-log' },

  { id: 'read-notices', group: 'communication', kind: 'action', name: 'Receive notices', help: 'Notices in the bell, and those shown on the way into an inspection.' },
  { id: 'manage-chat', group: 'communication', kind: 'action', name: 'Chat groups', help: 'Create chat groups, rename or remove conversations, and remove messages in groups.', needs: 'use-chat' },
]

export const PERMISSION_INFO: Record<Permission, PermissionInfo> = Object.fromEntries(PERMISSIONS.map((p) => [p.id, p])) as Record<Permission, PermissionInfo>

/**
 * Where each role starts, on a new installation; administrators change them
 * under Users → Roles. The migration that made the tables seeded these.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Reads what the floor produces; writes nothing, hears nothing.
  viewer: ['view-inspections', 'view-history', 'view-order-sheet', 'view-dashboard', 'view-mtc', 'view-all-sessions'],
  inspector: ['view-inspections', 'view-history', 'view-mtc', 'view-coil-search', 'use-chat', 'record-inspection', 'edit-open-session', 'read-notices'],
  supervisor: [
    'view-inspections',
    'view-history',
    'view-order-sheet',
    'view-mtc',
    'view-coil-search',
    'use-chat',
    'view-audit-log',
    'record-inspection',
    'edit-open-session',
    'edit-closed-session',
    'view-all-sessions',
    'export-records',
    'view-all-follow-ups',
    'read-notices',
  ],
  admin: PERMISSION_IDS,
}

/** The account above the roles: the AI assistant's owner. */
export const ADMIN_PLUS = 'ADMIN+'

/** A person's own difference from their role: a permission given (true) or taken away (false). */
export interface PermissionOverride {
  permission: Permission
  granted: boolean
}

/** What a person holds: their role's set, with their overrides; ADMIN+ holds everything. */
export function effectivePermissions(rolePermissions: readonly Permission[], overrides: readonly PermissionOverride[], adminPlus = false): Permission[] {
  if (adminPlus) return [...PERMISSION_IDS]
  const held = new Set<Permission>(rolePermissions)
  for (const o of overrides) {
    if (o.granted) held.add(o.permission)
    else held.delete(o.permission)
  }
  return PERMISSION_IDS.filter((p) => held.has(p))
}

/**
 * The overrides that make `wanted` out of a role's set: only the
 * differences, so a person follows later changes to their role in every
 * other permission.
 */
export function overridesFor(rolePermissions: readonly Permission[], wanted: readonly Permission[]): PermissionOverride[] {
  const role = new Set(rolePermissions)
  const want = new Set(wanted)
  return PERMISSION_IDS.flatMap((p): PermissionOverride[] => {
    if (want.has(p) && !role.has(p)) return [{ permission: p, granted: true }]
    if (!want.has(p) && role.has(p)) return [{ permission: p, granted: false }]
    return []
  })
}

/** Whether a set of permissions — a person's, as the server or the client holds it — includes one. */
export function can(held: ReadonlySet<Permission> | readonly Permission[] | null | undefined, permission: Permission): boolean {
  if (!held) return false
  return Array.isArray(held) ? held.includes(permission) : (held as ReadonlySet<Permission>).has(permission)
}

/** The permissions in `wanted` that `editor` does not hold: one cannot give what one does not have. */
export function permissionsBeyond(editor: readonly Permission[], wanted: readonly Permission[]): Permission[] {
  const held = new Set(editor)
  return PERMISSION_IDS.filter((p) => wanted.includes(p) && !held.has(p))
}

/** The screens' paths, in the bar's order, for the first one a person may open. */
export const SCREEN_PATHS: readonly { permission: Permission; path: string }[] = [
  { permission: 'view-inspections', path: '/' },
  { permission: 'view-history', path: '/history' },
  { permission: 'view-order-sheet', path: '/access' },
  { permission: 'view-dashboard', path: '/dashboard' },
  { permission: 'view-mtc', path: '/mtc' },
  { permission: 'view-coil-search', path: '/coils' },
  { permission: 'use-chat', path: '/chat' },
  { permission: 'manage-configuration', path: '/admin/configuration' },
  { permission: 'import-data', path: '/admin/import' },
  { permission: 'manage-users', path: '/admin/users' },
  { permission: 'view-audit-log', path: '/admin/audit' },
  { permission: 'manage-notices', path: '/notices' },
  { permission: 'view-release-notes', path: '/admin/whats-new' },
]

/** Where a person lands: the first screen they may open, or null when they may open none. */
export function homePath(held: readonly Permission[]): string | null {
  return SCREEN_PATHS.find((s) => held.includes(s.permission))?.path ?? null
}

// ---- The API ------------------------------------------------------------------

/** GET /api/users/roles — each role's set, and which roles the asker may change. */
export interface RolePermissionsResponse {
  roles: Record<Role, Permission[]>
  /** The admin role's set is changed by ADMIN+ alone. */
  editable: Role[]
}

/** PUT /api/users/roles/:role */
export interface RolePermissionsRequest {
  permissions: Permission[]
}

/** PUT /api/users/:id/permissions — the person's overrides, all of them (a full replacement). */
export interface UserPermissionsRequest {
  overrides: PermissionOverride[]
}
