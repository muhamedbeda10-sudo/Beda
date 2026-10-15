// ============================================================================
// Write operations. Each one calls the API and then invalidates the cached
// reads it affects, so every open screen refreshes itself.
// ============================================================================

import type { QueryClient } from '@tanstack/react-query'
import {
  EXISTING_KEYS_MAX,
  type ClearOrdersResult,
  type ClearProductionRecordsResult,
  type CreateIntegrationKeyResponse,
  type CloseSessionRequest,
  type CorrectDefectRequest,
  type CorrectDimensionRequest,
  type CreatePDIRequest,
  type CreateUserRequest,
  type ExistingKeysResponse,
  type ImportCompareResponse,
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
  type AvatarResponse,
  type SetAvatarRequest,
} from '@qc/shared/api'
import type { DashboardLayouts, KpiThresholds } from '@qc/shared/kpi'
import type {
  AiAccess,
  AiAccessListResponse,
  AiAccessRequest,
  AiConversation,
  AiConversationGroup,
  AiConversationUpdate,
  AiMessagesResponse,
  AiReport,
  AiReportRunResponse,
  AiSaveReportRequest,
  AiSaveReportResponse,
  AiSetKeyRequest,
  AiSettingsRequest,
  AiSettingsResponse,
  AiStopResponse,
} from '@qc/shared/ai'
import type { ChatConversation, ChatMessage, DefectResult, DimensionResult, Notice, NoticeFile, NoticeForUser, ManagedUser, Role, StoredFile, UserProfile, WorkInstruction } from '@qc/shared/types'
import type { RolePermissionsRequest, RolePermissionsResponse, UserPermissionsRequest } from '@qc/shared/permissions'
import { api } from '@/lib/api'
import { keys } from '@/services/queries'
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

// ---- §7.7 Access order sync --------------------------------------------------

/** Sync now: the agent picks it up within a minute. */
export async function requestOrderSync(qc: QueryClient): Promise<void> {
  await api<void>('/integrations/order-sync/request', { method: 'POST' })
  await qc.invalidateQueries({ queryKey: ['integrations', 'order-sync'] })
}

/** A new key for the agent: the secret comes back this once. */
export async function createIntegrationKey(qc: QueryClient, name: string): Promise<CreateIntegrationKeyResponse> {
  const res = await api<CreateIntegrationKeyResponse>('/integrations/keys', { method: 'POST', body: { name } })
  await qc.invalidateQueries({ queryKey: ['integrations', 'order-sync'] })
  return res
}

export async function revokeIntegrationKey(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/integrations/keys/${id}/revoke`, { method: 'POST' })
  await qc.invalidateQueries({ queryKey: ['integrations', 'order-sync'] })
}

// ---- Bulk import -----------------------------------------------------------

export type ImportTarget = 'orders' | 'coils' | 'item-dimension-order' | 'machines' | 'work-center-defects' | 'production-records'

/** Where each importer lives on the API, and which cached reads it changes.
 *  The dashboard reads all of them — an order line imported changes coverage,
 *  a machine's factory changes which list a figure belongs to — so `['kpi']`
 *  is invalidated alongside whatever the target names. (The production
 *  record, §24, is read by the assistant alone; its summary is what moves.) */
function importEndpoint(target: ImportTarget): { path: string; invalidates: readonly string[] } {
  switch (target) {
    case 'orders':
    case 'coils':
    case 'production-records':
      return { path: `/${target}`, invalidates: [target] }
    default:
      return { path: `/master/${target}`, invalidates: ['master', target] }
  }
}

/**
 * §24 — mark every production record deleted, for a wrong import. Nothing is
 * erased: a record the next file still carries comes back through the
 * import's upsert. Only an administrator, and the count is audited.
 */
export async function clearProductionRecords(qc: QueryClient): Promise<ClearProductionRecordsResult> {
  const result = await api<ClearProductionRecordsResult>('/production-records', { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['production-records'] })
  return result
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

/** One batch written. What it changed is refreshed once the whole import ends (refreshAfterImport), not after every batch. */
export async function importRows(target: ImportTarget, rows: unknown[]): Promise<ImportResult> {
  const { path } = importEndpoint(target)
  return api<ImportResult>(`${path}/import`, { method: 'POST', body: { rows }, gzip: true })
}

/** What importing a batch would do, written nowhere: the keys it would add and those it would change (orders and the production record). */
export async function compareImportRows(target: ImportTarget, rows: unknown[]): Promise<ImportCompareResponse> {
  const { path } = importEndpoint(target)
  return api<ImportCompareResponse>(`${path}/import/compare`, { method: 'POST', body: { rows }, gzip: true })
}

/** The screens an import changed, refreshed once when it ends (or stops): the target's lists and the dashboard's figures. */
export async function refreshAfterImport(qc: QueryClient, target: ImportTarget): Promise<void> {
  const { invalidates } = importEndpoint(target)
  await Promise.all([qc.invalidateQueries({ queryKey: [...invalidates] }), qc.invalidateQueries({ queryKey: ['kpi'] })])
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

/** §14 — a person's own differences from their role, all of them. */
export async function saveUserPermissions(qc: QueryClient, id: string, body: UserPermissionsRequest): Promise<ManagedUser> {
  const user = await api<ManagedUser>(`/users/${id}/permissions`, { method: 'PUT', body })
  await qc.invalidateQueries({ queryKey: ['users'] })
  return user
}

/** §14 — a role's set, all of it. */
export async function saveRolePermissions(qc: QueryClient, role: Role, body: RolePermissionsRequest): Promise<RolePermissionsResponse> {
  const res = await api<RolePermissionsResponse>(`/users/roles/${role}`, { method: 'PUT', body })
  await qc.invalidateQueries({ queryKey: ['users'] })
  return res
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

/** Set the signed-in person's own profile photo (a square JPEG and its small copy); their circles show it at once. */
export async function setMyAvatar(qc: QueryClient, myId: string, photo: SetAvatarRequest): Promise<void> {
  const saved = await api<AvatarResponse>('/auth/me/avatar', { method: 'PUT', body: photo })
  qc.setQueryData(keys.myAvatar, saved)
  qc.setQueryData(keys.userAvatar(myId), photo.thumbDataUrl ?? photo.dataUrl)
}

/** Remove it: the circles show the initials again. */
export async function removeMyAvatar(qc: QueryClient, myId: string): Promise<void> {
  await api<void>('/auth/me/avatar', { method: 'DELETE' })
  qc.setQueryData<AvatarResponse>(keys.myAvatar, { dataUrl: null })
  qc.setQueryData(keys.userAvatar(myId), null)
}

// ---- §20 AI assistant --------------------------------------------------------

/** The switch and the app-wide cap. The usage reads the cap, and the owner's own "can it answer?" may change. */
export async function saveAiSettings(qc: QueryClient, body: AiSettingsRequest): Promise<AiSettingsResponse> {
  const res = await api<AiSettingsResponse>('/ai/settings', { method: 'PUT', body })
  qc.setQueryData(keys.aiSettings, res)
  void qc.invalidateQueries({ queryKey: keys.aiMe })
  await qc.invalidateQueries({ queryKey: ['ai', 'usage'] })
  return res
}

/** Set the Anthropic API key. The server tries it with Anthropic before it keeps it; it is never sent back. */
export async function setAiKey(qc: QueryClient, apiKey: string): Promise<AiSettingsResponse> {
  const body: AiSetKeyRequest = { apiKey }
  const res = await api<AiSettingsResponse>('/ai/key', { method: 'PUT', body })
  qc.setQueryData(keys.aiSettings, res)
  void qc.invalidateQueries({ queryKey: keys.aiMe })
  return res
}

export async function removeAiKey(qc: QueryClient): Promise<AiSettingsResponse> {
  const res = await api<AiSettingsResponse>('/ai/key', { method: 'DELETE' })
  qc.setQueryData(keys.aiSettings, res)
  void qc.invalidateQueries({ queryKey: keys.aiMe })
  return res
}

/** The access list with one person's row put in (replacing theirs, or added at the end). Nothing cached, nothing to change. */
export function upsertAiAccess(old: AiAccessListResponse | undefined, row: AiAccess): AiAccessListResponse | undefined {
  if (!old) return old
  const at = old.people.findIndex((p) => p.userId === row.userId)
  const people = at < 0 ? [...old.people, row] : old.people.map((p, i) => (i === at ? row : p))
  return { ...old, people }
}

/** The access list without one person. Untouched, the same object comes back. */
export function withoutAiAccess(old: AiAccessListResponse | undefined, userId: string): AiAccessListResponse | undefined {
  if (!old || !old.people.some((p) => p.userId === userId)) return old
  return { ...old, people: old.people.filter((p) => p.userId !== userId) }
}

/**
 * Give a person the assistant, or change what they have of it (the owner
 * only). Their next question uses it. The list of people still to add loses
 * them, and the owner's own access may be the one that changed.
 */
export async function saveAiAccess(qc: QueryClient, userId: string, body: AiAccessRequest): Promise<AiAccess> {
  const row = await api<AiAccess>(`/ai/access/${encodeURIComponent(userId)}`, { method: 'PUT', body })
  qc.setQueryData<AiAccessListResponse>(keys.aiAccess, (old) => upsertAiAccess(old, row))
  void qc.invalidateQueries({ queryKey: keys.aiPeople })
  void qc.invalidateQueries({ queryKey: keys.aiMe })
  await qc.invalidateQueries({ queryKey: keys.aiAccess })
  return row
}

/** Take the assistant from a person (the owner only). Their conversations and reports stay theirs, out of reach until it is given back. */
export async function removeAiAccess(qc: QueryClient, userId: string): Promise<void> {
  await api<void>(`/ai/access/${encodeURIComponent(userId)}`, { method: 'DELETE' })
  qc.setQueryData<AiAccessListResponse>(keys.aiAccess, (old) => withoutAiAccess(old, userId))
  void qc.invalidateQueries({ queryKey: keys.aiPeople })
  void qc.invalidateQueries({ queryKey: keys.aiMe })
  await qc.invalidateQueries({ queryKey: keys.aiAccess })
}

/**
 * Rename, pin or unpin, move to a group or out of one, archive or unarchive
 * one of this person's conversations. The open conversation's title follows,
 * and every list, group count and search is read again.
 */
export async function updateAiConversation(qc: QueryClient, id: string, update: AiConversationUpdate): Promise<AiConversation> {
  const conversation = await api<AiConversation>(`/ai/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: update })
  qc.setQueryData<AiMessagesResponse>(keys.aiMessages(id), (old) => (old ? { ...old, conversation } : old))
  await qc.invalidateQueries({ queryKey: keys.aiConversations })
  return conversation
}

export async function createAiConversationGroup(qc: QueryClient, name: string): Promise<AiConversationGroup> {
  const group = await api<AiConversationGroup>('/ai/conversation-groups', { method: 'POST', body: { name } })
  await qc.invalidateQueries({ queryKey: keys.aiConversationGroups })
  return group
}

export async function renameAiConversationGroup(qc: QueryClient, id: string, name: string): Promise<AiConversationGroup> {
  const group = await api<AiConversationGroup>(`/ai/conversation-groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } })
  await qc.invalidateQueries({ queryKey: keys.aiConversationGroups })
  return group
}

/** Remove a group: its conversations go back to the list, so every list is read again. */
export async function deleteAiConversationGroup(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/ai/conversation-groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: keys.aiConversations })
}

/** Remove a conversation from this person's history (the server keeps it for the cost record). */
export async function deleteAiConversation(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/ai/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  qc.removeQueries({ queryKey: keys.aiMessages(id) })
  await qc.invalidateQueries({ queryKey: keys.aiConversations })
}

/** A conversation as cached, its running answer marked as stopping. Nothing running, the same object comes back. */
export function withStopping(old: AiMessagesResponse | undefined): AiMessagesResponse | undefined {
  if (!old?.running || old.running.stopping) return old
  return { ...old, running: { ...old.running, stopping: true } }
}

/**
 * Stop the answer the server is writing in a conversation, whoever's device asked it: it ends at its next step and
 * is kept as stopped. A conversation cached with the answer running says "Stopping…" at once, and goes on being asked
 * again until the answer has ended; otherwise (none was being written any more, or the copy here is older than the
 * answer) it is fetched again, to show where it stands.
 */
export async function stopAiAnswer(qc: QueryClient, conversationId: string): Promise<void> {
  const res = await api<AiStopResponse>(`/ai/conversations/${encodeURIComponent(conversationId)}/stop`, { method: 'POST' })
  const key = keys.aiMessages(conversationId)
  const cached = qc.getQueryData<AiMessagesResponse>(key)
  if (res.stopping && cached?.running) qc.setQueryData(key, withStopping(cached))
  else void qc.invalidateQueries({ queryKey: key })
}

/**
 * A conversation as cached, with the answer of `turnId` marked as saved as
 * `reportId` (or, with `turnId` null, every mark of `reportId` taken off — the
 * report was deleted). Untouched, the same object comes back, so nothing
 * redraws for a conversation the change is not in.
 */
export function markSavedReport(old: AiMessagesResponse | undefined, turnId: string | null, reportId: string): AiMessagesResponse | undefined {
  if (!old) return old
  let changed = false
  const messages = old.messages.map((m) => {
    if (m.role !== 'assistant') return m
    if (turnId !== null && m.turnId === turnId && m.savedReportId !== reportId) {
      changed = true
      return { ...m, savedReportId: reportId }
    }
    if (turnId === null && m.savedReportId === reportId) {
      changed = true
      const { savedReportId: _gone, ...rest } = m
      return rest
    }
    return m
  })
  return changed ? { ...old, messages } : old
}

/**
 * Save an answer as a report. With an adjustable period (the default) the
 * server asks the model once to make the period changeable, which counts
 * toward this month's caps — so whether the assistant can still answer is
 * asked again, and the owner's figures (when the owner's page is cached)
 * follow. No amount is kept from the response: the chat shows none.
 */
export async function saveAiReport(qc: QueryClient, body: AiSaveReportRequest): Promise<AiSaveReportResponse> {
  const res = await api<AiSaveReportResponse>('/ai/reports', { method: 'POST', body })
  qc.setQueryData(keys.aiReport(res.report.id), res.report)
  // The answer's "Save as report" becomes "Saved · Open" wherever its conversation is cached.
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => markSavedReport(old, body.turnId, res.report.id))
  void qc.invalidateQueries({ queryKey: keys.aiMe })
  void qc.invalidateQueries({ queryKey: keys.aiSettings })
  void qc.invalidateQueries({ queryKey: keys.aiAccess })
  void qc.invalidateQueries({ queryKey: ['ai', 'usage'] })
  await qc.invalidateQueries({ queryKey: keys.aiReports })
  return res
}

/**
 * Save an answer as a report, one save of an answer at a time. The save lives
 * in the query client's mutation cache under the answer's turn, not in the
 * answer on screen: leaving the thread while it runs (History, My reports, the
 * panel closed — the model call can take a while) and coming back finds it
 * still on its way, then what it ended with (the reason the period stayed
 * fixed, the budget being spent) — never a "Save as report" ready again, which
 * would send a second save and a second paid call to the model. Kept for the
 * session (signing out clears the client); a new save of the answer replaces
 * the last. Null when this answer is being saved already.
 */
export function startSavingAiReport(qc: QueryClient, body: AiSaveReportRequest): Promise<AiSaveReportResponse> | null {
  const mutationKey = keys.aiSaveReport(body.turnId)
  const cache = qc.getMutationCache()
  const earlier = cache.findAll({ mutationKey, exact: true })
  if (earlier.some((m) => m.state.status === 'pending')) return null
  for (const m of earlier) cache.remove(m)
  // Sent as it is, online or not (as any other request here): a failure says so at once rather than waiting for a connection.
  const save = cache.build<AiSaveReportResponse, Error, AiSaveReportRequest, unknown>(qc, { mutationKey, mutationFn: (b) => saveAiReport(qc, b), gcTime: Infinity, networkMode: 'always' })
  return save.execute(body)
}

export async function renameAiReport(qc: QueryClient, id: string, title: string): Promise<AiReport> {
  const report = await api<AiReport>(`/ai/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } })
  qc.setQueryData(keys.aiReport(id), report)
  qc.setQueriesData<AiReportRunResponse>({ queryKey: keys.aiReportRuns(id) }, (old) => (old ? { ...old, report } : old))
  await qc.invalidateQueries({ queryKey: keys.aiReports })
  return report
}

/** Remove a report from this person's reports; the answer it came from offers "Save as report" again. */
export async function deleteAiReport(qc: QueryClient, id: string): Promise<void> {
  await api<void>(`/ai/reports/${encodeURIComponent(id)}`, { method: 'DELETE' })
  qc.removeQueries({ queryKey: keys.aiReport(id) })
  qc.removeQueries({ queryKey: keys.aiReportRuns(id) })
  // The save that made it no longer says the answer is saved (see startSavingAiReport).
  const saves = qc.getMutationCache()
  for (const m of saves.findAll({ mutationKey: ['ai', 'save-report'] })) {
    if ((m.state.data as AiSaveReportResponse | undefined)?.report.id === id) saves.remove(m)
  }
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => markSavedReport(old, null, id))
  await qc.invalidateQueries({ queryKey: keys.aiReports })
}
