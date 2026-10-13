// ============================================================================
// The assistant's playbook: what it follows in every new conversation. A
// person's own instructions and the conclusions they kept from an analysis,
// and the instructions the assistant's owner sets for everyone (instructions
// only: a conclusion comes from data its person may read, others may not).
// Saved from a conversation, at the person's word, or on the Playbook page.
// ============================================================================

export type PlaybookScope = 'personal' | 'shared'
export type PlaybookKind = 'instruction' | 'conclusion'

/** Most entries a person keeps; most the owner keeps for everyone. */
export const PLAYBOOK_MAX_PERSONAL = 30
export const PLAYBOOK_MAX_SHARED = 20
/** An entry's words, and a conclusion's basis, at most. */
export const PLAYBOOK_TEXT_MAX = 500
export const PLAYBOOK_BASIS_MAX = 200

export const PLAYBOOK_KIND_LABEL: Record<PlaybookKind, string> = { instruction: 'Instruction', conclusion: 'Conclusion' }

export interface PlaybookEntry {
  id: string
  scope: PlaybookScope
  kind: PlaybookKind
  text: string
  /** For a conclusion: what it was drawn from (the data, the period); else empty. */
  basis: string
  createdAt: string
  updatedAt: string
  createdByName: string
  /** Where it was last added or changed: in a conversation with the assistant, or on the page. */
  source: 'assistant' | 'page'
  /** The conversation it was last added or changed in, when that was the assistant (and the person's own). */
  conversationId: string | null
  /** Whether the person asking may change or remove it. */
  mayEdit: boolean
}

export interface PlaybookResponse {
  entries: PlaybookEntry[]
  /** Whether the person may set instructions for everyone (the assistant's owner). */
  mayShare: boolean
}

export interface SavePlaybookEntryRequest {
  scope: PlaybookScope
  kind: PlaybookKind
  text: string
  basis?: string
}

export interface UpdatePlaybookEntryRequest {
  text?: string
  basis?: string
}

/** A playbook change the assistant made, as a card in its answer: what it saved, and how the entry stands now. */
export interface AiPlaybookPart {
  type: 'playbook'
  changeId: string
  entryId: string
  action: 'add' | 'change' | 'remove'
  scope: PlaybookScope
  kind: PlaybookKind
  /** The words as this change left them (for a removal, as they were). */
  text: string
  basis: string
  /** The entry now: as this change left it, changed since, or removed. */
  state: 'current' | 'changed' | 'removed'
}
