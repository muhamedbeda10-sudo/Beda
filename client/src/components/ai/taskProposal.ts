// ============================================================================
// A task card in words and checks: how it stands, the card as it stands now
// in the cached conversation, and when the cards wait for the answer being
// written. Pure, so it is tested without a browser.
// ============================================================================

import type { AiMessagesResponse, AiTaskPart } from '@qc/shared/ai'
import type { BadgeTone } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { isInFlight, type LiveTurn } from './liveTurn'

export const TASK_CARD_STATE_LABEL: Record<AiTaskPart['state'], string> = { proposed: 'Not sent yet', sent: 'Sent', discarded: 'Discarded', superseded: 'Replaced' }
export const TASK_CARD_STATE_TONE: Record<AiTaskPart['state'], BadgeTone> = { proposed: 'amber', sent: 'green', discarded: 'neutral', superseded: 'neutral' }

/** Whom it goes to, in a line: "Cyril Second", "Cyril Second and Sara Ali", "Cyril Second and 3 others". */
export function recipientsText(names: readonly string[]): string {
  if (names.length === 0) return 'no one'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]} and ${names.length - 1} others`
}

/** What the toast says once it is sent. */
export function sentToast(part: AiTaskPart): string {
  const to = recipientsText(part.draft?.assignees.map((a) => a.name) ?? [])
  return part.taskNumber !== undefined ? `T-${part.taskNumber} sent to ${to}.` : `Sent to ${to}.`
}

/**
 * The conversation as cached, with a card as it stands now (after Send task
 * or Discard): every answer holding that card gets the new one; nothing else
 * changes, and an untouched list is the same object.
 */
export function replaceTaskPart(old: AiMessagesResponse | undefined, part: AiTaskPart): AiMessagesResponse | undefined {
  if (!old) return old
  let changed = false
  const messages = old.messages.map((m) => {
    if (!m.parts.some((p) => p.type === 'task' && p.proposalId === part.proposalId)) return m
    changed = true
    return { ...m, parts: m.parts.map((p) => (p.type === 'task' && p.proposalId === part.proposalId ? part : p)) }
  })
  return changed ? { ...old, messages } : old
}

/**
 * Whether the cached conversation holds a card still waiting for Send task,
 * other than `except`: a newer card may have replaced it (the server marks it
 * so as it keeps the newer one), so the conversation is worth fetching again.
 */
export function hasOpenTaskCard(old: AiMessagesResponse | undefined, except: string): boolean {
  return !!old?.messages.some((m) => m.parts.some((p) => p.type === 'task' && p.ok && p.state === 'proposed' && p.proposalId !== except))
}

/**
 * Whether the task cards of a conversation's saved answers wait before they
 * can be sent: the answer being written in it has drafted a task card that
 * passed, which may be a newer version of one of them. The server marks the
 * one it replaces only as it keeps the round that drafted it — and a card
 * sent before then would go out next to its replacement. So their buttons
 * wait until the answer ends; the conversation fetched meanwhile says which
 * one it replaced.
 */
export function taskCardsWait(live: LiveTurn | null, conversationId: string | null): boolean {
  return !!live && conversationId !== null && live.conversationId === conversationId && isInFlight(live) && live.parts.some((p) => p.type === 'task' && p.ok)
}

/** The card as a refusal says it stands now (sent already, discarded, replaced), when the server sent it along. */
export function taskPartOf(e: unknown, proposalId: string): AiTaskPart | null {
  if (!(e instanceof ApiError) || !e.details || typeof e.details !== 'object') return null
  const part = (e.details as { part?: unknown }).part
  if (!part || typeof part !== 'object') return null
  const p = part as Partial<AiTaskPart>
  return p.type === 'task' && p.proposalId === proposalId && typeof p.state === 'string' ? (p as AiTaskPart) : null
}
