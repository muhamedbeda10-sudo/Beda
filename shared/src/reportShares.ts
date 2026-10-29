// ============================================================================
// A saved report shared with people and roles. Its owner — while they have
// the AI assistant — shares it with chosen people and with everyone holding
// a role, the assistant or not; each recipient finds it on the Reports page,
// fills in what the owner's report asks for, and runs it. A run reads the
// data as its owner may read it now (within the domains its queries were
// written under), whoever runs it; a recipient never sees its SQL, never
// changes it, and takes it to Excel only with the app's permission to
// export records.
//
// The owner's routes are under /api/ai/reports/:id/shares (the assistant's,
// for the owner alone); the recipients' under /api/reports/shared (anyone
// signed in: to whom a report is not shared, it does not exist).
// ============================================================================

import type { AiChartSpec, AiDayRange, AiReportPeriod, AiReportSectionDisplay, AiReportSectionRun, AiReportTree } from './ai'
import type { AiReportInput, AiReportInputValues } from './aiReportInputs'
import type { ResolvedReportStyle } from './reportStyles'
import type { Role } from './types'

/** Whom a report is shared with: one person, or everyone who holds a role (as they are at each request). */
export type ReportShareTarget = { kind: 'user'; userId: string } | { kind: 'role'; role: Role }

/** People and roles a report may be shared with at most. */
export const REPORT_SHARE_MAX_TARGETS = 100

/** A target as the owner's Share panel lists it. */
export type ReportShareView = ReportShareTarget & {
  /** "Ahmed Ali", "Every supervisor". */
  label: string
  /** A person whose account is no longer active: kept in the list, reached by nothing. */
  inactive?: boolean
  sharedAt: string
  sharedByName: string
}

/** One recipient's runs of the report, for its owner: who ran it, how often, and when last. */
export interface ReportShareRunner {
  userId: string
  name: string
  runs: number
  exports: number
  lastRunAt: string
}

/** A person the owner may pick: every live account but the owner. */
export interface ReportSharePerson {
  id: string
  name: string
  username: string
  role: Role
}

/** GET (and PUT) /api/ai/reports/:id/shares — whom it is shared with, who ran it, and whom it may be shared with. */
export interface ReportSharesResponse {
  reportId: string
  shares: ReportShareView[]
  runners: ReportShareRunner[]
  people: ReportSharePerson[]
  roles: Role[]
}

/** PUT /api/ai/reports/:id/shares — people and roles to add and to remove, in one change. */
export interface ReportShareRequest {
  add?: ReportShareTarget[]
  remove?: ReportShareTarget[]
}

/** Everyone holding a role, as a list of recipients names them (as an automation's recipients read). */
export const ROLE_SHARE_LABEL: Record<Role, string> = {
  viewer: 'Every viewer',
  warehouse: 'Everyone in the warehouse',
  inspector: 'Every inspector',
  supervisor: 'Every supervisor',
  admin: 'Every administrator',
}

export const roleShareLabel = (role: Role): string => ROLE_SHARE_LABEL[role] ?? `Every ${role}`

/** A target's key, the same for the same person or role however it was sent. */
export const shareKey = (t: ReportShareTarget): string => (t.kind === 'user' ? `user:${t.userId.toLowerCase()}` : `role:${t.role}`)

// ---- The recipients' side ----------------------------------------------------------

/** A report shared with the person, as the Reports page lists it. */
export interface SharedReportSummary {
  id: string
  title: string
  description?: string
  /** Who shared it: its owner. */
  ownerName: string
  /** When what it holds last changed. */
  updatedAt: string
  inputCount: number
  sectionCount: number
}

export interface SharedReportsResponse {
  reports: SharedReportSummary[]
  hasMore: boolean
}

/** GET /api/reports/shared/status — whether anything is shared with the person: whether the Reports page is theirs. */
export interface SharedReportsStatus {
  any: boolean
}

/** A section as a recipient knows it: what it shows and how; never its SQL. */
export interface SharedReportSection {
  title: string
  chart?: AiChartSpec
  display?: AiReportSectionDisplay
  tree?: AiReportTree
  note?: string
}

/** A report shared with the person, as they open it. */
export interface SharedReport {
  id: string
  title: string
  description?: string
  ownerName: string
  updatedAt: string
  period: AiReportPeriod | null
  /** Whether the period can be changed for a run. */
  adjustable: boolean
  inputs: AiReportInput[]
  sections: SharedReportSection[]
  /** Whether it can run: false once its owner no longer has the assistant (`unavailable` says so). */
  available: boolean
  unavailable?: string
  /** Whether this person may take it to Excel (the app's permission to export records). */
  excel: boolean
}

/** GET /api/reports/shared/:id/run — the report run now, as its owner's report view shows a run. */
export interface SharedReportRunResponse {
  report: SharedReport
  period: (AiDayRange & { label: string; overridden: boolean }) | null
  sections: AiReportSectionRun[]
  inputs: AiReportInputValues
  ranAt: string
  style?: ResolvedReportStyle
}

/** The shape of a run both report views draw: the owner's and a recipient's. */
export interface ReportRunView {
  report: { title: string; description?: string; inputs: AiReportInput[] }
  period: (AiDayRange & { label: string; overridden: boolean }) | null
  sections: AiReportSectionRun[]
  inputs: AiReportInputValues
  ranAt: string
  style?: ResolvedReportStyle
}
