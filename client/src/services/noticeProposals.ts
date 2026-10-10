// ============================================================================
// §23 — a notice card's buttons through the API. Each puts the card the
// server answered into every cached conversation that holds it, so the card
// follows wherever the conversation is open. Once a card has changed the
// notices, the bell and the administrator's Notices page are fetched again.
//
// A refusal as a conflict means the card was decided elsewhere (another
// tab), a newer card replaced it, or the notice changed since it was made
// (the server marks it out of date): the card as the server sent it along
// goes into the cache, and the conversations are fetched again either way.
// ============================================================================

import type { QueryClient } from '@tanstack/react-query'
import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiNoticeApplyResponse, AiNoticeDiscardResponse, AiNoticePart } from '@qc/shared/noticeAssistant'
import { ApiError, api } from '@/lib/api'
import { noticePartOf, replaceNoticePart } from '@/components/ai/noticeProposal'

const path = (proposalId: string, action: 'apply' | 'discard') => `/ai/notice-proposals/${encodeURIComponent(proposalId)}/${action}`

/** Every notices query: the bell's inbox, the administrator's list, who read each one. */
const NOTICES = ['notices'] as const

/** The card as it stands now, in every cached conversation that holds it. */
function settleNoticeCard(qc: QueryClient, part: AiNoticePart): void {
  qc.setQueriesData<AiMessagesResponse>({ queryKey: ['ai', 'messages'] }, (old) => replaceNoticePart(old, part))
}

/** A decision on a card; a conflict settles the card as the server says it stands, then the refusal goes on to the card. */
async function decide<T>(qc: QueryClient, proposalId: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const part = noticePartOf(e, proposalId)
      if (part) settleNoticeCard(qc, part)
      void qc.invalidateQueries({ queryKey: ['ai', 'messages'] })
      // Applied already (another tab, a double press): the notices moved, and this device may not have seen it.
      void qc.invalidateQueries({ queryKey: NOTICES })
    }
    throw e
  }
}

/** Press the card's button (the person who asked for it only): publish, change, withdraw or delete the notice. */
export async function applyNoticeProposal(qc: QueryClient, proposalId: string): Promise<AiNoticeApplyResponse> {
  const res = await decide(qc, proposalId, () => api<AiNoticeApplyResponse>(path(proposalId, 'apply'), { method: 'POST' }))
  settleNoticeCard(qc, res.part)
  void qc.invalidateQueries({ queryKey: NOTICES })
  return res
}

/** Set the card aside: nothing changes. */
export async function discardNoticeProposal(qc: QueryClient, proposalId: string): Promise<AiNoticeDiscardResponse> {
  const res = await decide(qc, proposalId, () => api<AiNoticeDiscardResponse>(path(proposalId, 'discard'), { method: 'POST' }))
  settleNoticeCard(qc, res.part)
  return res
}
