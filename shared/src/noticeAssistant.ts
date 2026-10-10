// ============================================================================
// §23 — notices through the assistant. Anyone with the assistant can ask
// about the notices they could see in the app: their own (the bell), and —
// for an administrator — every notice and who read it. An administrator the
// owner allows can also have the assistant write one: it drafts the notice
// (or a change, a withdrawal, a deletion) as a card that shows exactly what
// will go out and to whom, and nothing changes until they press its button.
// ============================================================================

import type { NoticeMatchMode, NoticeSeverity, NoticeTarget } from './types'

/** What a card does to the notices when its button is pressed. */
export type AiNoticeAction = 'create' | 'update' | 'withdraw' | 'delete'
export const AI_NOTICE_ACTIONS: readonly AiNoticeAction[] = ['create', 'update', 'withdraw', 'delete']

/** A notice's words, look, days and audience, as the card shows them. Photos and files are added on the Notices page. */
export interface AiNoticeDraft {
  title: string
  body: string
  severity: NoticeSeverity
  requiresAck: boolean
  matchMode: NoticeMatchMode
  /** Factory day, YYYY-MM-DD. */
  validFrom: string
  /** Factory day, YYYY-MM-DD; null: until withdrawn. */
  validTo: string | null
  targets: NoticeTarget[]
  /** Photos and files the notice already carries (an update keeps them). */
  attachments?: number
}

/** Who a notice reaches. */
export interface AiNoticeReach {
  /** No targets: every active account. */
  everyone: boolean
  /** Active accounts it names through users and roles (or everyone); null when it reaches people only at a place. */
  people: number | null
  /** It is shown where the work is (a machine, an order, a shift…), to whoever meets it there. */
  placeBound: boolean
}

/**
 * 'stale': for a change, a withdrawal or a deletion, the notice changed (or
 * went) after the card was made, so the card can no longer be applied.
 * 'superseded': a newer card of the same conversation replaced it.
 */
export type AiNoticeProposalState = 'proposed' | 'applied' | 'discarded' | 'superseded' | 'stale'

/** A notice card in an answer. */
export interface AiNoticePart {
  type: 'notice'
  proposalId: string
  /** The server accepted the draft; when not, `error` says why (the assistant was told too). */
  ok: boolean
  error?: string
  action: AiNoticeAction
  /** update / withdraw / delete: the notice it acts on; create: the notice made, once applied. */
  noticeId?: string
  /** create / update: the notice as it will be. */
  draft?: AiNoticeDraft
  /** update / withdraw / delete: the notice as it was when the card was made. */
  before?: AiNoticeDraft
  reach?: AiNoticeReach
  state: AiNoticeProposalState
  appliedAt?: string
  appliedByName?: string
}

export interface AiNoticeApplyResponse {
  part: AiNoticePart
}

export interface AiNoticeDiscardResponse {
  part: AiNoticePart
}
