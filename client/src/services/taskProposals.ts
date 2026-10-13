// ============================================================================
// A task card's buttons through the API. Each puts the card the server
// answered into every cached conversation that holds it, so the card follows
// wherever the conversation is open. Once a task is sent, the Tasks lists and
// counts are fetched again.
//
// A refusal as a conflict means the card was decided elsewhere (another tab)
// or a newer card replaced it: the card as the server sent it along goes into
// the cache, and the conversations are fetched again either way.
// ============================================================================

import type { QueryClient } from '@tanstack/react-query'
import type { AiMessagesResponse, AiTaskPart, AiTaskProposalResponse } from '@qc/shared/ai'
import { ApiError, api } from '@/lib/api'
import { replaceTaskPart, taskPartOf } from '@/components/ai/taskProposal'
import { taskKeys } from './tasks'

const path = (proposalId: string, action: 'send' | 'discard') => `/ai/task-proposals/${encodeURIComponent(proposalId)}/${action}`

/** The card as it stands now, in every cached conversation that holds it. */
function settleTaskCard(qc: QueryClient, part: AiTaskPart): void {
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => replaceTaskPart(old, part))
}

/** A decision on a card; a conflict settles the card as the server says it stands, then the refusal goes on to the card. */
async function decide(qc: QueryClient, proposalId: string, action: 'send' | 'discard'): Promise<AiTaskProposalResponse> {
  try {
    const res = await api<AiTaskProposalResponse>(path(proposalId, action), { method: 'POST' })
    settleTaskCard(qc, res.part)
    return res
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const part = taskPartOf(e, proposalId)
      if (part) settleTaskCard(qc, part)
      void qc.invalidateQueries({ queryKey: ['ai', 'messages'] })
      // Sent already (another tab, a double press): the lists moved, and this device may not have seen it.
      void qc.invalidateQueries({ queryKey: taskKeys.all })
    }
    throw e
  }
}

/** Send task (the person who asked for it only): the task made, each person told. */
export async function sendTaskProposal(qc: QueryClient, proposalId: string): Promise<AiTaskProposalResponse> {
  const res = await decide(qc, proposalId, 'send')
  void qc.invalidateQueries({ queryKey: taskKeys.all })
  return res
}

/** Set the card aside: nothing is sent. */
export function discardTaskProposal(qc: QueryClient, proposalId: string): Promise<AiTaskProposalResponse> {
  return decide(qc, proposalId, 'discard')
}
