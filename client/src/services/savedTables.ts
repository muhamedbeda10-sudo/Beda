// ============================================================================
// The assistant's saved tables through the API: the tables the person may
// read, a table's first rows, computing one again, and removing one. A
// removal also settles every cached card of that table, wherever its
// conversation is open.
// ============================================================================

import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { SavedTable, SavedTableRowsResponse, SavedTablesResponse } from '@qc/shared/savedTables'
import { api } from '@/lib/api'

export const savedTablesKey = ['ai', 'saved-tables'] as const
const rowsKey = (id: string) => ['ai', 'saved-tables', id, 'rows'] as const

const path = (id: string) => `/ai/saved-tables/${encodeURIComponent(id)}`

export function useSavedTables(enabled = true) {
  return useQuery({ queryKey: savedTablesKey, queryFn: () => api<SavedTablesResponse>('/ai/saved-tables'), enabled })
}

export function useSavedTableRows(id: string, enabled: boolean) {
  return useQuery({ queryKey: rowsKey(id), queryFn: () => api<SavedTableRowsResponse>(`${path(id)}/rows`), enabled })
}

export async function refreshSavedTable(qc: QueryClient, id: string): Promise<SavedTable> {
  const table = await api<SavedTable>(`${path(id)}/refresh`, { method: 'POST' })
  void qc.invalidateQueries({ queryKey: savedTablesKey })
  return table
}

/** Every card of this table in the cached conversations, marked removed. */
export function settleSavedTableCards(old: AiMessagesResponse | undefined, tableId: string): AiMessagesResponse | undefined {
  if (!old) return old
  let changed = false
  const messages = old.messages.map((m) => {
    if (!m.parts.some((p) => p.type === 'saved-table' && p.tableId === tableId && p.state !== 'removed')) return m
    changed = true
    return { ...m, parts: m.parts.map((p) => (p.type === 'saved-table' && p.tableId === tableId ? { ...p, state: 'removed' as const } : p)) }
  })
  return changed ? { ...old, messages } : old
}

export async function removeSavedTable(qc: QueryClient, id: string): Promise<void> {
  await api<void>(path(id), { method: 'DELETE' })
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => settleSavedTableCards(old, id))
  void qc.invalidateQueries({ queryKey: savedTablesKey })
}
