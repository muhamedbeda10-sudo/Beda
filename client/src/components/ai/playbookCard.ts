// ============================================================================
// A playbook card in words, and the cards of an entry as they stand once it
// is changed or removed elsewhere. Pure, so it is tested without a browser.
// ============================================================================

import type { AiMessagesResponse } from '@qc/shared/ai'
import type { AiPlaybookPart } from '@qc/shared/playbook'

/** What the card says the assistant did. */
export function playbookCardTitle(part: Pick<AiPlaybookPart, 'action' | 'scope' | 'kind'>): string {
  const what = part.kind === 'instruction' ? (part.scope === 'shared' ? 'Instruction for everyone' : 'Instruction') : 'Conclusion'
  if (part.action === 'add') return `${what} saved to the playbook`
  if (part.action === 'change') return `${what} changed in the playbook`
  return `${what} removed from the playbook`
}

/** How its entry stands now, when no longer as this change left it. */
export function playbookCardState(part: Pick<AiPlaybookPart, 'action' | 'state'>): string | null {
  if (part.action === 'remove') return null
  if (part.state === 'removed') return 'Removed since'
  if (part.state === 'changed') return 'Changed since'
  return null
}

/**
 * The conversation as cached, with every card of an entry marked as it now
 * stands (removed, or changed since). A removal marks them all; a change
 * marks those it did not make. An untouched list is the same object.
 */
export function settlePlaybookCards(old: AiMessagesResponse | undefined, entryId: string, state: 'changed' | 'removed'): AiMessagesResponse | undefined {
  if (!old) return old
  let changed = false
  const messages = old.messages.map((m) => {
    if (!m.parts.some((p) => p.type === 'playbook' && p.entryId === entryId && p.action !== 'remove' && p.state !== state && p.state !== 'removed')) return m
    changed = true
    return { ...m, parts: m.parts.map((p) => (p.type === 'playbook' && p.entryId === entryId && p.action !== 'remove' && p.state !== 'removed' ? { ...p, state } : p)) }
  })
  return changed ? { ...old, messages } : old
}
