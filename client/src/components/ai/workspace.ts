// ============================================================================
// §20 — the assistant's full page and its addresses. /ai is the workspace
// (the conversation on screen in its ?c=), /ai/reports/<id> one saved report
// run there. The panel and the page show the same conversation and the same
// answer being written; these say which address shows what, so a link copied
// from one opens the same thing in the other's place.
// ============================================================================

import type { AiReportSummary } from '@qc/shared/ai'

export const AI_WORKSPACE_PATH = '/ai'

/** A saved report open in the assistant: its id, and what a list knew of it, drawn until the report itself arrives. */
export interface AiOpenReport {
  id: string
  known?: AiReportSummary
  /** Open on its Share panel. */
  share?: boolean
}

/** How a report is opened from an answer's card: on its Share panel (a share card), or as it opens. */
export interface AiOpenReportOptions {
  share?: boolean
}

/** Which list the page's side column shows. */
export type AiWorkspaceList = 'conversations' | 'reports'

/** What the panel hands the page on Expand (and the page the panel on Dock), as router state. */
export interface AiWorkspaceState {
  known?: AiReportSummary
  list?: AiWorkspaceList
  /** The report opens on its Share panel. */
  share?: boolean
}

/** Whether an address is the workspace's: /ai and anything under it — not /admin/ai, the owner's settings. */
export function isAiWorkspacePath(pathname: string): boolean {
  return pathname === AI_WORKSPACE_PATH || pathname.startsWith(`${AI_WORKSPACE_PATH}/`)
}

/** The report an address of the workspace opens, or null for the conversation (or an address it does not know). */
export function workspaceReportId(pathname: string): string | null {
  const m = /^\/ai\/reports\/([^/]+)\/?$/.exec(pathname)
  if (!m) return null
  try {
    const id = decodeURIComponent(m[1]).trim()
    return id || null
  } catch {
    return null
  }
}

/** Whether an address under /ai is one the workspace knows: /ai itself, or a report's. */
export function isKnownWorkspacePath(pathname: string): boolean {
  return pathname === AI_WORKSPACE_PATH || pathname === `${AI_WORKSPACE_PATH}/` || workspaceReportId(pathname) !== null
}

/** The address of the workspace showing a conversation (null: a new one) or a report. */
export function aiWorkspaceHref(target: { conversationId?: string | null; reportId?: string | null }): string {
  if (target.reportId) return `${AI_WORKSPACE_PATH}/reports/${encodeURIComponent(target.reportId)}`
  return target.conversationId ? `${AI_WORKSPACE_PATH}?c=${encodeURIComponent(target.conversationId)}` : AI_WORKSPACE_PATH
}

/** The conversation a workspace address names in its ?c=, or null. */
export function workspaceConversationId(search: string): string | null {
  const c = new URLSearchParams(search).get('c')?.trim()
  return c ? c : null
}
