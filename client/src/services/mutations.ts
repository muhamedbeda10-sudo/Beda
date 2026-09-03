// ============================================================================
// Write operations. Each one calls the API and then invalidates the cached
// reads it affects, so every open screen refreshes itself.
// ============================================================================

import type { QueryClient } from '@tanstack/react-query'
import type {
  CloseSessionRequest,
  CorrectDefectRequest,
  CorrectDimensionRequest,
  CreatePDIRequest,
  CreateUserRequest,
  ExistingKeysResponse,
  ImportResult,
  MasterKind,
  MasterRecordByKind,
  PDIWithOrder,
  PurgeAuditRequest,
  SaveSampleRequest,
  SaveSampleResponse,
  SessionWithOrder,
  StartSessionRequest,
  UpdateUserRequest,
} from '@qc/shared/api'
import type { DefectResult, DimensionResult, UserProfile } from '@qc/shared/types'
import { api } from '@/lib/api'

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

// ---- Bulk import -----------------------------------------------------------

export type ImportTarget = 'orders' | 'coils' | 'item-dimension-order'

export async function existingKeys(target: ImportTarget, keys: string[]): Promise<Set<string>> {
  if (target === 'item-dimension-order') {
    // Small configuration table: the list itself is the lookup.
    const rows = await api<MasterRecordByKind['item-dimension-order'][]>('/master/item-dimension-order')
    return new Set(rows.map((r) => `${r.item.trim().toLowerCase()}||${r.dimensionName.trim().toLowerCase()}`))
  }
  const res = await api<ExistingKeysResponse>(`/${target}/existing-keys`, { method: 'POST', body: { keys } })
  return new Set(res.existing)
}

export async function importRows(qc: QueryClient, target: ImportTarget, rows: unknown[]): Promise<ImportResult> {
  let result: ImportResult
  if (target === 'item-dimension-order') {
    result = await api<ImportResult>('/master/item-dimension-order/import', { method: 'POST', body: { rows } })
    await qc.invalidateQueries({ queryKey: ['master', 'item-dimension-order'] })
  } else {
    result = await api<ImportResult>(`/${target}/import`, { method: 'POST', body: { rows } })
    await qc.invalidateQueries({ queryKey: [target] })
  }
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
