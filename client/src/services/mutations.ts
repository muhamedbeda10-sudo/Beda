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
  type UpdateUserRequest,
  type UpdateWorkInstructionRequest,
  type UploadWorkInstructionFields,
  type ReRecordSampleRequest,
  type ReRecordSampleResponse,
  type ReopenSessionRequest,
} from '@qc/shared/api'
import type { DefectResult, DimensionResult, UserProfile, WorkInstruction } from '@qc/shared/types'
import { api } from '@/lib/api'
import { chunk } from '@/lib/utils'

export async function startSession(qc: QueryClient, body: StartSessionRequest): Promise<SessionWithOrder> {
  const session = await api<SessionWithOrder>('/sessions', { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  await qc.invalidateQueries({ queryKey: ['orders', body.orderId] })
  return session
}

export async function closeSession(qc: QueryClient, sessionId: string, body: CloseSessionRequest): Promise<SessionWithOrder> {
  const session = await api<SessionWithOrder>(`/sessions/${sessionId}/close`, { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  return session
}

export async function deleteSession(qc: QueryClient, sessionId: string): Promise<void> {
  await api<void>(`/sessions/${sessionId}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
}

/** Re-record a whole sample from History; refused with a conflict if it moved. */
export async function reRecordSample(qc: QueryClient, sessionId: string, sampleId: string, body: ReRecordSampleRequest): Promise<ReRecordSampleResponse> {
  const result = await api<ReRecordSampleResponse>(`/sessions/${sessionId}/samples/${sampleId}`, { method: 'PUT', body })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  await qc.invalidateQueries({ queryKey: ['samples'] })
  await qc.invalidateQueries({ queryKey: ['audit'] })
  return result
}

/** Reopen a closed session so samples can be added again (closed-record rights). */
export async function reopenSession(qc: QueryClient, sessionId: string, version: number): Promise<SessionWithOrder> {
  const session = await api<SessionWithOrder>(`/sessions/${sessionId}/reopen`, { method: 'POST', body: { version } satisfies ReopenSessionRequest })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  return session
}

/** Mark a sample deleted (administrators only). The rows stay; the sample leaves every list. */
export async function deleteSample(qc: QueryClient, sampleId: string): Promise<void> {
  await api<void>(`/samples/${sampleId}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  await qc.invalidateQueries({ queryKey: ['samples'] })
}

export async function saveSample(qc: QueryClient, sessionId: string, body: SaveSampleRequest): Promise<SaveSampleResponse> {
  const result = await api<SaveSampleResponse>(`/sessions/${sessionId}/samples`, { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  await qc.invalidateQueries({ queryKey: ['orders'] })
  await qc.invalidateQueries({ queryKey: ['coils', 'usage'] })
  return result
}

export async function correctDimension(qc: QueryClient, id: string, body: CorrectDimensionRequest): Promise<DimensionResult> {
  const row = await api<DimensionResult>(`/samples/dimensions/${id}`, { method: 'PATCH', body })
  await qc.invalidateQueries({ queryKey: ['samples', row.sampleId] })
  await qc.invalidateQueries({ queryKey: ['audit'] })
  return row
}

export async function correctDefect(qc: QueryClient, id: string, body: CorrectDefectRequest): Promise<DefectResult> {
  const row = await api<DefectResult>(`/samples/defects/${id}`, { method: 'PATCH', body })
  await qc.invalidateQueries({ queryKey: ['samples', row.sampleId] })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  await qc.invalidateQueries({ queryKey: ['audit'] })
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

export async function createMaster<K extends MasterKind>(qc: QueryClient, kind: K, body: Omit<MasterRecordByKind[K], 'id'>): Promise<MasterRecordByKind[K]> {
  const row = await api<MasterRecordByKind[K]>(`/master/${kind}`, { method: 'POST', body })
  await qc.invalidateQueries({ queryKey: ['master', kind] })
  return row
}

export async function updateMaster<K extends MasterKind>(
  qc: QueryClient,
  kind: K,
  id: string,
  body: Omit<MasterRecordByKind[K], 'id'>,
): Promise<MasterRecordByKind[K]> {
  const row = await api<MasterRecordByKind[K]>(`/master/${kind}/${id}`, { method: 'PUT', body })
  await qc.invalidateQueries({ queryKey: ['master', kind] })
  return row
}

export async function deleteMaster(qc: QueryClient, kind: MasterKind, id: string): Promise<void> {
  await api<void>(`/master/${kind}/${id}`, { method: 'DELETE' })
  await qc.invalidateQueries({ queryKey: ['master', kind] })
}

/** Mark every order line deleted ahead of a fresh ERP export. */
export async function clearOrders(qc: QueryClient): Promise<ClearOrdersResult> {
  const result = await api<ClearOrdersResult>('/orders/clear', { method: 'POST' })
  await qc.invalidateQueries({ queryKey: ['orders'] })
  await qc.invalidateQueries({ queryKey: ['sessions'] })
  return result
}

// ---- Bulk import -----------------------------------------------------------

export type ImportTarget = 'orders' | 'coils' | 'item-dimension-order' | 'machines' | 'work-center-defects'

/** Where each importer lives on the API, and which cached reads it changes. */
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
  await qc.invalidateQueries({ queryKey: [...invalidates] })
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
