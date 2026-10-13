// ============================================================================
// §20 — an answer the server writes while this device only follows it: the
// conversation reopened while its answer runs (a reload, another device), or
// a stream this device let go of. The conversation is asked again every few
// seconds while the server says the answer runs (useAiMessages); once a fetch
// no longer says so, the answer has ended, and what the end of a streamed
// answer refreshes is refreshed then — and the bell, which the server tells
// when an answer ends with no one watching. Plain functions, so it is tested
// without a browser.
// ============================================================================

import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { AiMessagesResponse } from '@qc/shared/ai'
import { notificationKeys } from '@/services/notifications'
import { keys } from '@/services/queries'

/** The conversation a query of the cache holds the messages of, or null for any other query. */
export function messagesConversation(key: QueryKey): string | null {
  const [scope, what, id] = key
  return scope === 'ai' && what === 'messages' && typeof id === 'string' && id !== '' ? id : null
}

/**
 * Follows, conversation by conversation, whether its answer runs as its last
 * fetch said, and tells when one has just ended: it ran then and does not
 * now. What this device wrote into the cache itself (`manual`: an answer it
 * streamed, put in as it ended) is noted without telling, since the end of
 * that stream refreshes what it changed.
 */
export function runningWatch(): (conversationId: string, data: AiMessagesResponse | undefined, manual: boolean) => boolean {
  const running = new Map<string, boolean>()
  return (conversationId, data, manual) => {
    const was = running.get(conversationId) ?? false
    const now = !!data?.running
    running.set(conversationId, now)
    return was && !now && !manual
  }
}

/**
 * What an answer followed through its conversation changed elsewhere once it
 * has ended: the history, whether the next question can be asked, the
 * owner's figures when the owner's page is open beside the panel, and the
 * bell. The conversation itself is as just fetched: that fetch said it ended.
 */
export function refreshAfterAnswer(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: keys.aiConversations })
  void qc.invalidateQueries({ queryKey: keys.aiMe })
  void qc.invalidateQueries({ queryKey: keys.aiSettings })
  void qc.invalidateQueries({ queryKey: keys.aiAccess })
  void qc.invalidateQueries({ queryKey: ['ai', 'usage'] })
  void qc.invalidateQueries({ queryKey: notificationKeys.all })
}
