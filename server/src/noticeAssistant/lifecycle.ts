// ============================================================================
// §23 — the button on a notice card. Pressing it writes the notice exactly as
// the Notices page would (noticesService.ts: the same checks, the same audit
// entries, as the person who pressed it); Discard sets the card aside. Who may
// press either is the routes' to check, again at the press: the person who
// asked, while they may still have the assistant write notices.
//
// What keeps a press sound:
//   • the card is locked (FOR UPDATE) for the whole press, so of two presses
//     at once the second finds it decided: a card is applied once, and the
//     second press is told so with the card as it now stands;
//   • for a change, a withdrawal or a deletion, the notice is locked too and
//     must be exactly as it was when the card was made (its updated_at, to the
//     microsecond) and still there: otherwise the card turns stale and nothing
//     is written — the person asks the assistant again, over the notice as it
//     is now. A withdrawal changes updated_at, so it counts as a change too;
//   • the notice is locked FOR NO KEY UPDATE, never FOR UPDATE: an answer
//     storing a newer card holds a key share on it (the card's foreign key)
//     while it waits for this card's lock to mark it superseded, and waiting
//     for that share while holding the card would deadlock (the lock-order
//     care of the automations' activation, §22). Storing a card takes no lock
//     on the card it revises, so a press never waits on an answer;
//   • every version of a card is one notice (proposals.ts noticeVersions):
//     a new notice is refused, the card turned stale, once any other version
//     of it was published — an earlier one pressed while the model was
//     writing (so never superseded), a later one, or one beside it. Presses
//     of versions of one card wait for one another (a lock on the first
//     version, which no answer storing a card ever takes), so two pressed at
//     once publish it once;
//   • a card stored under older rules that no longer passes the page's own
//     checks writes nothing: refused with the card as it stands.
// ============================================================================

import type { AiNoticeApplyResponse, AiNoticeDiscardResponse, AiNoticePart } from '@qc/shared/noticeAssistant'
import type { SaveNoticeRequest } from '@qc/shared/api'
import { withTransaction, type Db, type Queryable } from '../db/pool'
import { HttpError, notFound } from '../lib/errors'
import { createNotice, deleteNotice, loadNotice, noticeSaveSchema, updateNotice, withdrawNotice, type NoticeWriter } from '../modules/noticesService'
import { findNoticeProposal, noticePart, noticeVersions, type StoredNoticeProposal } from './proposals'

/** A press refused: a 409 with the card as it now stands, for the person's screen to show. */
const refused = (message: string, part: AiNoticePart) => new HttpError(409, 'conflict', message, { part })

const MESSAGES = {
  applied: 'This card was already applied.',
  discarded: 'This card was discarded. Ask the assistant again.',
  superseded: 'A newer version of this card was made below; use that one.',
  stale: 'The notice changed after this card was made, so it can no longer be applied. Ask the assistant again.',
  failed: 'This card did not pass its checks, so there is nothing to apply. Ask the assistant to fix it.',
  changed: 'The notice changed (or was withdrawn or deleted) after this card was made, so nothing was written. Ask the assistant again.',
  republish: 'Another version of this card was published already, so this one would publish the notice twice. Ask the assistant to change that notice instead.',
  rules: 'This card no longer passes the Notices page\'s checks, so nothing was written. Ask the assistant to make it again.',
}

/** The advisory lock class of the presses of one card's versions, keyed by its first version: they wait for one another. */
const VERSIONS_LOCK_CLASS = 8_811_038

/** Why a card cannot be pressed in the state it is in; null while it is proposed and passed. */
function undecided(p: StoredNoticeProposal): string | null {
  if (p.state === 'applied') return MESSAGES.applied
  if (p.state === 'discarded') return MESSAGES.discarded
  if (p.state === 'superseded') return MESSAGES.superseded
  if (p.state === 'stale') return MESSAGES.stale
  if (!p.ok) return MESSAGES.failed
  return null
}

/** The card as it now stands, read after the press's transaction ended. */
async function partNow(db: Db, id: string, userId: string): Promise<AiNoticePart> {
  return noticePart((await findNoticeProposal(db, id, userId))!)
}

/**
 * Whether the notice a card acts on is exactly as it was when the card was
 * made, and still there; locked until the press ends either way. Compared in
 * the database, where updated_at keeps its microseconds.
 */
async function noticeUnchanged(tx: Queryable, p: StoredNoticeProposal): Promise<boolean> {
  const { rows } = await tx.query<{ same: boolean }>(
    `SELECT (n.deleted_at IS NULL AND n.updated_at = $2::timestamptz) AS same FROM notices n WHERE n.id = $1 FOR NO KEY UPDATE`,
    [p.noticeId, p.noticeUpdatedAt],
  )
  return rows[0]?.same === true
}

/**
 * A card's draft as the Notices page would save it: no photos or files of its
 * own, or the notice's own kept. Checked again as the page's request would
 * be: a card stored under an older version of these rules applies only if it
 * still passes; null when it does not (checkCard holds every new card to them).
 */
function saveRequest(p: StoredNoticeProposal, kept: { imageIds: string[]; fileIds: string[] }): SaveNoticeRequest | null {
  const d = p.draft!
  const checked = noticeSaveSchema.safeParse({
    title: d.title,
    body: d.body,
    severity: d.severity,
    requiresAck: d.requiresAck,
    matchMode: d.matchMode,
    validFrom: d.validFrom,
    validTo: d.validTo,
    targets: d.targets,
    ...kept,
  })
  return checked.success ? (checked.data as SaveNoticeRequest) : null
}

const turnStale = (tx: Queryable, id: string) => tx.query(`UPDATE ai_notice_proposals SET state = 'stale' WHERE id = $1`, [id])

/**
 * Apply one's own card: the notice written, the card applied, in one
 * transaction. A refusal (decided already, stale) is a 409 carrying the card
 * as it now stands; a card turned stale stays so.
 */
export async function applyNoticeProposal(db: Db, tz: string, proposalId: string, by: NoticeWriter): Promise<AiNoticeApplyResponse> {
  const outcome = await withTransaction(db, async (tx): Promise<{ refused: string } | null> => {
    const p = await findNoticeProposal(tx, proposalId, by.id, true)
    if (!p) throw notFound('That card')
    const why = undecided(p)
    if (why) return { refused: why }
    let noticeId = p.noticeId
    switch (p.action) {
      case 'create': {
        // One notice from all the versions of the card: read again once the presses of the others are through.
        const { first } = await noticeVersions(tx, p.conversationId, p.id)
        await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [VERSIONS_LOCK_CLASS, first])
        if ((await noticeVersions(tx, p.conversationId, p.id)).published) {
          await turnStale(tx, p.id)
          return { refused: MESSAGES.republish }
        }
        const request = saveRequest(p, { imageIds: [], fileIds: [] })
        if (!request) return { refused: MESSAGES.rules }
        noticeId = (await createNotice(tx, tz, by, request)).id
        break
      }
      case 'update':
      case 'withdraw':
      case 'delete': {
        if (!(await noticeUnchanged(tx, p))) {
          await turnStale(tx, p.id)
          return { refused: MESSAGES.changed }
        }
        if (p.action === 'update') {
          // Its photos and files stay as they are: the assistant never touches them.
          const notice = (await loadNotice(tx, tz, p.noticeId!))!
          const request = saveRequest(p, { imageIds: notice.imageIds, fileIds: notice.files.map((f) => f.id) })
          if (!request) return { refused: MESSAGES.rules }
          await updateNotice(tx, tz, by, notice.id, request)
        } else if (p.action === 'withdraw') await withdrawNotice(tx, tz, by, p.noticeId!)
        else await deleteNotice(tx, by, p.noticeId!)
        break
      }
    }
    await tx.query(`UPDATE ai_notice_proposals SET state = 'applied', applied_at = now(), applied_by = $2, notice_id = $3 WHERE id = $1`, [p.id, by.id, noticeId])
    return null
  })
  const part = await partNow(db, proposalId, by.id)
  if (outcome) throw refused(outcome.refused, part)
  return { part }
}

/** Discard one's own card: it says so; nothing was ever written. Discarding one discarded already changes nothing. */
export async function discardNoticeProposal(db: Db, proposalId: string, by: NoticeWriter): Promise<AiNoticeDiscardResponse> {
  const outcome = await withTransaction(db, async (tx): Promise<{ refused: string } | null> => {
    const p = await findNoticeProposal(tx, proposalId, by.id, true)
    if (!p) throw notFound('That card')
    if (p.state === 'discarded') return null
    if (p.state === 'applied') return { refused: 'This card was applied: change the notice on the Notices page, or ask the assistant.' }
    if (p.state === 'superseded') return { refused: MESSAGES.superseded }
    if (p.state === 'stale') return { refused: MESSAGES.stale }
    if (!p.ok) return { refused: 'This card did not pass its checks; there is nothing to discard.' }
    await tx.query(`UPDATE ai_notice_proposals SET state = 'discarded' WHERE id = $1`, [p.id])
    return null
  })
  const part = await partNow(db, proposalId, by.id)
  if (outcome) throw refused(outcome.refused, part)
  return { part }
}
