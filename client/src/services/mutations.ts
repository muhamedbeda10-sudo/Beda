// ============================================================================
// Write operations. Each one calls the API and then invalidates the cached
// reads it affects, so every open screen refreshes itself.
// ============================================================================

import type { QueryClient } from '@tanstack/react-query'
import {
  EXISTING_KEYS_MAX,
  type ClearOrdersResult,
  type CloseSessionRequest,
  type CorrectDefectRequest,
  type CorrectDimensionRequest,
  type CreatePDIRequest,
  type CreateUserRequest,
  type ExistingKeysResponse,
  type ImportResult,
  type MasterKind,
  type MasterRecordByKind,
  type PDIWithOrder,
  type PurgeAuditRequest,
  type SaveSampleRequest,
  type SaveSampleResponse,
  type SessionWithOrder,
  type StartSessionRequest,
  type StartWithSampleRequest,
  type StartWithSampleResponse,
  type UpdateUserRequest,
  type UpdateWorkInstructionRequest,
  type UploadWorkInstructionFields,
  type ReRecordSampleRequest,
  type ReRecordSampleResponse,
  type ReopenSessionRequest,
  type UpdateSessionQuantitiesRequest,
  type KpiThresholdsResponse,
  type AcknowledgeNoticeRequest,
  type MatchNoticesRequest,
  type MatchNoticesResponse,
  type SaveNoticeRequest,
  type ChatMessagesResponse,
  type CreateConversationRequest,
  type SendChatMessageRequest,
  type UpdateGroupRequest,
  type ReleaseStateResponse,
  type HiddenInsightsResponse,
  type DashboardLayoutResponse,
} from '@qc/shared/api'
import type { DashboardLayouts, KpiThresholds } from '@qc/shared/kpi'
import type { ChatConversation, ChatMessage, DefectResult, DimensionResult, Notice, NoticeFile, NoticeForUser, StoredFile, UserProfile, WorkInstruction } from '@qc/shared/types'
import { api } from '@/lib/api'
import { chunk } from '@/lib/utils'

/**
 * What a write to the inspection record makes stale.
 *
 * The dashboard counts that same record, so `['kpi']` is never left out: a
 * session deleted in History must not keep its pieces on the dashboard's
 * tiles, and a corrected measurement must not keep its old verdict in the
 * capability table. Every write below goes through here rather than listing
 * keys of its own, so a write added later cannot quietly forget it.
 */
async function recordChanged(qc: QueryClient, ...also: readonly string[][]): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['sessions'] }),
    qc.invalidateQueries({ queryKey: ['kpi'] }),
    ...also.map((queryKey) => qc.invalidateQueries({ queryKey })),
  ])
}

export async function startSession(qc: QueryClient, body: StartSessionRequest): Promise<SessionWithOrder> {
  const session = await api<SessionWithOrder>('/sessions', { method: 'POST', body })
  await recordChanged(qc, ...('orderId' in body ? [['orders', body.orderId]] : []))
  return session
}

/** §4.4 — the session and its first sample, as one request and one transaction. */
export async function startSessionWithSample(qc: QueryClient, body: StartWithSampleRequest): Promise<StartWithSampleResponse> {
  const res = await api<StartWithSampleResponse>('/sessions/start-with-sample', { method: 'POST', body })
  await recordChanged(qc, ['orders'])
  return res
}

export async function closeSession(qc: QueryClient, sessionId: string, body: CloseSessionRequest): Promise<SessionWithOrder> {
  const session = await api<SessionWithOrder>(`/sessions/${sessionId}/close`, { method: 'POST', body })
  await recordChanged(qc)
  return session
}

export async function deleteSession(qc: QueryClient, sessionId: string): Promise<void> {
  await api<void>(`/sessions/${sessionId}`, { method: 'DELETE' })
  await recordChanged(qc)
}

/** Re-record a whole sample from History; refused with a conflict if it moved. */
export async function reRecordSample(qc: QueryClient, sessionId: string, sampleId: string, body: ReRecordSampleRequest): Promise<ReRecordSampleResponse> {
  const result = await api<ReRecordSampleResponse>(`/sessions/${sessionId}/samples/${sampleId}`, { method: 'PUT', body })
  qc.removeQueries({ queryKey: ['sessions', sessionId, 'wizard'] })
  await recordChanged(qc, ['samples'], ['audit'])
  return result
}

/** Reopen a closed session so samples can be added again (closed-record rights). */
export async function reopenSession(qc: QueryClient, sessionId: string, version: number): Promise<SessionWithOrder> {
  const session = await api<SessionWithOrder>(`/sessions/${sessionId}/reopen`, { method: 'POST', body: { version } satisfies ReopenSessionRequest })
  await recordChanged(qc)
  return session
}

/** §4 — correct a session's quantities; refused with a conflict if the session moved. */
export async function updateSessionQuantities(qc: QueryClient, sessionId: string, body: UpdateSessionQuantitiesRequest): Promise<SessionWithOrder> {
  const session = await api<SessionWithOrder>(`/sessions/${sessionId}/quantities`, { method: 'PATCH', body })
  await recordChanged(qc)
  return session
}

/** Mark a sample deleted (administrators only). The rows stay; the sample leaves every list. */
export async function deleteSample(qc: QueryClient, sampleId: string): Promise<void> {
  await api<void>(`/samples/${sampleId}`, { method: 'DELETE' })
  await recordChanged(qc, ['samples'])
}

/** Mark a note about an order deleted — administrators only; nothing is erased. */
export async function deleteNote(qc: QueryClient, sessionId: string, noteId: string): Promise<void> {
  await api<void>(`/sessions/${sessionId}/notes/${noteId}`, { method: 'DELETE' })
  await recordChanged(qc)
}

/** Discard a session that recorded no sample; the API refuses one that did. */
export async function discardSession(qc: QueryClient, sessionId: string): Promise<void> {
  await api<void>(`/sessions/${sessionId}/discard`, { method: 'POST' })
  await recordChanged(qc)
}

export async function saveSample(qc: QueryClient, sessionId: string, body: SaveSampleRequest): Promise<SaveSampleResponse> {
  const result = await api<SaveSampleResponse>(`/sessions/${sessionId}/samples`, { method: 'POST', body })
  // The next sample starts from what this one recorded (nominals, setup,
  // coils): drop the cached wizard context so it cannot be served stale.
  qc.removeQueries({ queryKey: ['sessions', sessionId, 'wizard'] })
  await recordChanged(qc, ['orders'], ['coils', 'usage'])
  return result
}

export async function correctDimension(qc: QueryClient, id: string, body: CorrectDimensionRequest): Promise<DimensionResult> {
  const row = await api<DimensionResult>(`/samples/dimensions/${id}`, { method: 'PATCH', body })
  // A corrected measurement changes the dimension figures the dashboard reports.
  await recordChanged(qc, ['samples', row.sampleId], ['audit'])
  return row
}

export async function correctDefect(qc: QueryClient, id: string, body: CorrectDefectRequest): Promise<DefectResult> {
  const row = await api<DefectResult>(`/samples/defects/${id}`, { method: 'PATCH', body })
  await recordChanged(qc, ['samples', row.sampleId], ['audit'])
  return row
}

export async function createPdi(qc: QueryClient, body: CreatePDIRequest): Promise<PDIWithOrder> {
  const doc = await api<PDIWithOrder>('/pdi', { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['pdi'] })
  return doc
}

export async function purgeAudit(qc: QueryClient, body: PurgeAuditRequest): Promise<number> {
  const res = await api<{ marked: number }>('/audit/purge', { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['audit'] })
  return res.marked
}

// ---- Master data -----------------------------------------------------------
// A machine's factory or display name decides which dashboard list a figure
// belongs to, so a master write refreshes the dashboard along with the list.

export async function createMaster<K extends MasterKind>(qc: QueryClient, kind: K, body: Omit<MasterRecordByKind[K], 'id'>): Promise<MasterRecordByKind[K]> {
  const row = await api<MasterRecordByKind[K]>(`/master/${kind}`, { method: 'POST', body })
  await Promise.all([qc.invalidateQueries({ queryKey: ['master', kind] }), qc.invalidateQueries({ queryKey: ['kpi'] })])
  return row
}

export async function updateMaster<K extends MasterKind>(
  qc: QueryClient,
  kind: K,
  id: string,
  body: Omit<MasterRecordByKind[K], 'id'>,
): Promise<MasterRecordByKind[K]> {
  const row = await api<MasterRecordByKind[K]>(`/master/${kind}/${id}`, { method: 'PUT', body })
  await Promise.all([qc.invalidateQueries({ queryKey: ['master', kind] }), qc.invalidateQueries({ queryKey: ['kpi'] })])
  return row
}

export async function deleteMaster(qc: QueryClient, kind: MasterKind, id: string): Promise<void> {
  await api<void>(`/master/${kind}/${id}`, { method: 'DELETE' })
  await Promise.all([qc.invalidateQueries({ queryKey: ['master', kind] }), qc.invalidateQueries({ queryKey: ['kpi'] })])
}

/** Mark many records of one table deleted in one request. */
export async function deleteManyMaster(qc: QueryClient, kind: MasterKind, ids: string[]): Promise<number> {
  const { deleted } = await api<{ deleted: number }>(`/master/${kind}/delete-many`, { method: 'POST', body: { ids } })
  await Promise.all([qc.invalidateQueries({ queryKey: ['master', kind] }), qc.invalidateQueries({ queryKey: ['kpi'] })])
  return deleted
}

/** Mark every order line deleted ahead of a fresh ERP export. */
export async function clearOrders(qc: QueryClient): Promise<ClearOrdersResult> {
  const result = await api<ClearOrdersResult>('/orders/clear', { method: 'POST' })
  await recordChanged(qc, ['orders'])
  return result
}

// ---- Bulk import -----------------------------------------------------------

export type ImportTarget = 'orders' | 'coils' | 'item-dimension-order' | 'machines' | 'work-center-defects'

/** Where each importer lives on the API, and which cached reads it changes.
 *  The dashboard reads all of them — an order line imported changes coverage,
 *  a machine's factory changes which list a figure belongs to — so `['kpi']`
 *  is invalidated alongside whatever the target names. */
function importEndpoint(target: ImportTarget): { path: string; invalidates: readonly string[] } {
  switch (target) {
    case 'orders':
    case 'coils':
      return { path: `/${target}`, invalidates: [target] }
    default:
      return { path: `/master/${target}`, invalidates: ['master', target] }
  }
}

/**
 * Which of the file's business keys already exist. Composite keys are sent
 * joined with "||", the same normalised form the API answers with. A file
 * from the ERP can hold tens of thousands of keys; the API answers at most
 * EXISTING_KEYS_MAX per request, so ask in slices and merge.
 */
export async function existingKeys(target: ImportTarget, keys: string[]): Promise<Set<string>> {
  const { path } = importEndpoint(target)
  const existing = new Set<string>()
  for (const slice of chunk(keys, EXISTING_KEYS_MAX)) {
    const res = await api<ExistingKeysResponse>(`${path}/existing-keys`, { method: 'POST', body: { keys: slice } })
    for (const key of res.existing) existing.add(key)
  }
  return existing
}

export async function importRows(qc: QueryClient, target: ImportTarget, rows: unknown[]): Promise<ImportResult> {
  const { path, invalidates } = importEndpoint(target)
  const result = await api<ImportResult>(`${path}/import`, { method: 'POST', body: { rows } })
  await Promise.all([qc.invalidateQueries({ queryKey: [...invalidates] }), qc.invalidateQueries({ queryKey: ['kpi'] })])
  return result
}

// ---- Users -----------------------------------------------------------------

export async function createUser(qc: QueryClient, body: CreateUserRequest): Promise<UserProfile> {
  const user = await api<UserProfile>('/users', { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['users'] })
  return user
}

export async function updateUser(qc: QueryClient, id: string, body: UpdateUserRequest): Promise<UserProfile> {
  const user = await api<UserProfile>(`/users/${id}`, { method: 'PATCH', body })
  await qc.invalidateQueries({ queryKey: ['users'] })
  return user
}

// ---- Work instructions -----------------------------------------------------

/** Upload one PDF. A new issue of an existing code supersedes the issue in force. */
export async function uploadWorkInstruction(qc: QueryClient, file: File, fields: UploadWorkInstructionFields): Promise<WorkInstruction> {
  const form = new FormData()
  form.set('file', file, file.name)
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') form.set(k, String(v))
  const created = await api<WorkInstruction>('/work-instructions', { method: 'POST', form })
  await qc.invalidateQueries({ queryKey: ['work-instructions'] })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  return created
}

export async function updateWorkInstruction(qc: QueryClient, id: string, body: UpdateWorkInstructionRequest): Promise<WorkInstruction> {
  const row = await api<WorkInstruction>(`/work-instructions/${id}`, { method: 'PATCH', body })
  await qc.invalidateQueries({ queryKey: ['work-instructions'] })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  return row
}

export async function deleteWorkInstruction(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/work-instructions/${id}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['work-instructions'] })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
}

/** Remove an account: it leaves the list, is signed out everywhere and its
 *  username is freed. History keeps the person's name. */
export async function deleteUser(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/users/${id}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['users'] })
}

// ---- §15 Dashboard ---------------------------------------------------------

export async function saveKpiThresholds(qc: QueryClient, body: KpiThresholds): Promise<KpiThresholdsResponse> {
  const res = await api<KpiThresholdsResponse>('/kpi/thresholds', { method: 'PUT', body })
  await qc.invalidateQueries({ queryKey: ['kpi'] })
  return res
}

// ---- §16 Notices -----------------------------------------------------------

/** What is still to be read where the reader is about to work. */
export async function matchNotices(body: MatchNoticesRequest): Promise<NoticeForUser[]> {
  const res = await api<MatchNoticesResponse>('/notices/match', { method: 'POST', body })
  return res.notices
}

export async function markNoticeSeen(qc: QueryClient, id: string, body: AcknowledgeNoticeRequest = {}): Promise<void> {
  await api<void>(`/notices/${id}/seen`, { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['notices'] })
}

export async function acknowledgeNotice(qc: QueryClient, id: string, body: AcknowledgeNoticeRequest = {}): Promise<void> {
  await api<void>(`/notices/${id}/acknowledge`, { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['notices'] })
}

export async function uploadNoticeFile(file: File): Promise<NoticeFile> {
  const form = new FormData()
  form.set('file', file, file.name)
  return api<NoticeFile>('/notices/files', { method: 'POST', form })
}

export async function saveNotice(qc: QueryClient, id: string | null, body: SaveNoticeRequest): Promise<Notice> {
  const res = id ? await api<Notice>(`/notices/${id}`, { method: 'PUT', body }) : await api<Notice>('/notices', { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['notices'] })
  return res
}

export async function withdrawNotice(qc: QueryClient, id: string): Promise<Notice> {
  const res = await api<Notice>(`/notices/${id}/withdraw`, { method: 'POST' })
  await qc.invalidateQueries({ queryKey: ['notices'] })
  return res
}

export async function deleteNotice(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/notices/${id}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['notices'] })
}

// ---- §17 Chat --------------------------------------------------------------

/** Older messages of a conversation, before the given instant. */
export async function loadOlderMessages(conversationId: string, before: string): Promise<ChatMessagesResponse> {
  return api<ChatMessagesResponse>(`/chat/conversations/${conversationId}/messages?before=${encodeURIComponent(before)}`)
}

export async function sendChatMessage(qc: QueryClient, conversationId: string, body: SendChatMessageRequest): Promise<ChatMessage> {
  const res = await api<ChatMessage>(`/chat/conversations/${conversationId}/messages`, { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['chat'] })
  return res
}

export async function editChatMessage(qc: QueryClient, id: string, body: string): Promise<ChatMessage> {
  const res = await api<ChatMessage>(`/chat/messages/${id}`, { method: 'PATCH', body: { body } })
  await qc.invalidateQueries({ queryKey: ['chat'] })
  return res
}

export async function deleteChatMessage(qc: QueryClient, id: string, scope: 'me' | 'everyone'): Promise<void> {
  await api<void>(`/chat/messages/${id}?scope=${scope}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['chat'] })
}

export async function toggleReaction(qc: QueryClient, id: string, emoji: string): Promise<ChatMessage> {
  const res = await api<ChatMessage>(`/chat/messages/${id}/reactions`, { method: 'POST', body: { emoji } })
  await qc.invalidateQueries({ queryKey: ['chat', 'messages'] })
  return res
}

export async function markConversationRead(qc: QueryClient, conversationId: string): Promise<void> {
  await api<void>(`/chat/conversations/${conversationId}/read`, { method: 'POST' })
  await qc.invalidateQueries({ queryKey: ['chat', 'unread'] })
  await qc.invalidateQueries({ queryKey: ['chat', 'conversations'] })
}

export async function createConversation(qc: QueryClient, body: CreateConversationRequest): Promise<ChatConversation> {
  const res = await api<ChatConversation>('/chat/conversations', { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['chat', 'conversations'] })
  return res
}

export async function updateGroup(qc: QueryClient, id: string, body: UpdateGroupRequest): Promise<ChatConversation> {
  const res = await api<ChatConversation>(`/chat/conversations/${id}`, { method: 'PATCH', body })
  await qc.invalidateQueries({ queryKey: ['chat', 'conversations'] })
  return res
}

/** An administrator removes a group: it leaves every member's list; its messages stay on the server. */
export async function deleteGroup(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/chat/conversations/${id}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['chat'] })
}

export async function uploadChatFile(file: File): Promise<StoredFile> {
  const form = new FormData()
  form.set('file', file, file.name)
  return api<StoredFile>('/chat/files', { method: 'POST', form })
}

/** §15 — an administrator's own board layout; everyone else keeps the default. */
export async function saveDashboardLayout(qc: QueryClient, layouts: DashboardLayouts): Promise<DashboardLayoutResponse> {
  const res = await api<DashboardLayoutResponse>('/kpi/layout', { method: 'PUT', body: { layouts } })
  qc.setQueryData(['kpi', 'layout'], res)
  return res
}

export async function resetDashboardLayout(qc: QueryClient): Promise<DashboardLayoutResponse> {
  const res = await api<DashboardLayoutResponse>('/kpi/layout', { method: 'DELETE' })
  qc.setQueryData(['kpi', 'layout'], res)
  return res
}

/** §15 — hide an insight for this person, on every device, until they show it again. */
export async function hideInsight(qc: QueryClient, key: string): Promise<void> {
  const res = await api<HiddenInsightsResponse>('/kpi/insights/hide', { method: 'POST', body: { key } })
  qc.setQueryData(['kpi', 'insights', 'hidden'], res)
}

export async function restoreInsight(qc: QueryClient, key: string): Promise<void> {
  const res = await api<HiddenInsightsResponse>('/kpi/insights/restore', { method: 'POST', body: { key } })
  qc.setQueryData(['kpi', 'insights', 'hidden'], res)
}

/** §18 — the newest release note dismissed; the mark only ever moves forward. */
export async function markReleaseSeen(qc: QueryClient, releaseId: string): Promise<void> {
  const res = await api<ReleaseStateResponse>('/releases/seen', { method: 'POST', body: { releaseId } })
  qc.setQueryData(['releases', 'state'], res)
}
