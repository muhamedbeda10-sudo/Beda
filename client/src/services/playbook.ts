// ============================================================================
// The assistant's playbook through the API: the person's entries (their own,
// and the owner's for everyone), and the writes behind the Playbook page and
// a playbook card's Remove. A removal also settles every cached card of that
// entry, wherever its conversation is open.
// ============================================================================

import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { PlaybookEntry, PlaybookResponse, SavePlaybookEntryRequest, UpdatePlaybookEntryRequest } from '@qc/shared/playbook'
import { settlePlaybookCards } from '@/components/ai/playbookCard'
import { api } from '@/lib/api'

export const playbookKey = ['ai', 'playbook'] as const

const path = (id: string) => `/ai/playbook/${encodeURIComponent(id)}`

export function usePlaybook(enabled = true) {
  return useQuery({ queryKey: playbookKey, queryFn: () => api<PlaybookResponse>('/ai/playbook'), enabled })
}

export async function addPlaybookEntry(qc: QueryClient, body: SavePlaybookEntryRequest): Promise<PlaybookEntry> {
  const entry = await api<PlaybookEntry>('/ai/playbook', { method: 'POST', body })
  void qc.invalidateQueries({ queryKey: playbookKey })
  return entry
}

export async function changePlaybookEntry(qc: QueryClient, id: string, body: UpdatePlaybookEntryRequest): Promise<PlaybookEntry> {
  const entry = await api<PlaybookEntry>(path(id), { method: 'PATCH', body })
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => settlePlaybookCards(old, id, 'changed'))
  void qc.invalidateQueries({ queryKey: playbookKey })
  return entry
}

export async function removePlaybookEntry(qc: QueryClient, id: string): Promise<void> {
  await api<void>(path(id), { method: 'DELETE' })
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => settlePlaybookCards(old, id, 'removed'))
  void qc.invalidateQueries({ queryKey: playbookKey })
}
