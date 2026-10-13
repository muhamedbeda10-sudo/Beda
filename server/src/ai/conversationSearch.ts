// ============================================================================
// §20 — finding a conversation again by what was said in it: its title, the
// questions asked in it and the answers' words (ai_turns.answer_text,
// migration 0052), archived ones included. Only the person's own.
//
// Text is compared folded (ai_search_fold in the database, foldForSearch
// here, the same rules): lower case, an Arabic letter written several ways
// read as one (أ إ آ ٱ as ا, ى as ي, ة as ه), the short vowels and the tatweel
// left out — "اجابة" finds "إجابةُ". The words are matched as written, as a
// part of the text (LIKE, its wildcards escaped), never as a pattern.
//
// Each conversation found says where the words are — its title first, else
// the latest question or answer that has them — with the words around them.
// ============================================================================

import { AI_CONVERSATION_SEARCH_LIMIT, type AiConversation, type AiConversationSearchHit, type AiConversationSearchResponse } from '@qc/shared/ai'
import type { Queryable } from '../db/pool'
import { CONVERSATION_SELECT, toConversation } from './transcript'

/** The marks left out: the short vowels (U+064B–U+0652), the superscript alef and the tatweel. */
const ARABIC_MARK = /^[ً-ْٰـ]$/u
const FOLDED: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه' }

/** One character folded as the database folds it; '' for a mark left out. */
function foldChar(ch: string): string {
  if (ARABIC_MARK.test(ch)) return ''
  const lower = ch.toLowerCase()
  return FOLDED[lower] ?? lower
}

/** Text folded as ai_search_fold folds it. */
export function foldForSearch(text: string): string {
  let out = ''
  for (const ch of text) out += foldChar(ch)
  return out
}

/** The words as a LIKE pattern: folded, its wildcards and escape taken as written. */
export function likePattern(words: string): string {
  return `%${foldForSearch(words).replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Characters of context a snippet keeps on each side of the match. */
const SNIPPET_BEFORE = 50
const SNIPPET_AFTER = 90

/**
 * The words around the first match in `text`, on one line, cut at a space
 * where it can be, with … where the text goes on; and where the match is in
 * the snippet. Without a match to be found (the database and this code
 * folded a character differently), the text's start.
 */
export function snippetAround(text: string, words: string): { snippet: string; match: { start: number; length: number } | null } {
  const flat = text.replace(/\s+/g, ' ').trim()
  // The folded text, and for each of its UTF-16 units the original's offset.
  let folded = ''
  const from: number[] = []
  let i = 0
  for (const ch of flat) {
    const f = foldChar(ch)
    for (let k = 0; k < f.length; k++) from.push(i)
    folded += f
    i += ch.length
  }
  from.push(flat.length)
  const needle = foldForSearch(words.replace(/\s+/g, ' ').trim())
  const at = needle ? folded.indexOf(needle) : -1
  if (at === -1) {
    const head = flat.length > SNIPPET_BEFORE + SNIPPET_AFTER ? `${cutAtSpace(flat.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER), 'end')}…` : flat
    return { snippet: head, match: null }
  }
  const start = from[at]
  // The match ends after its last folded unit's original character.
  const lastOriginal = from[at + needle.length - 1]
  let end = lastOriginal + (flat.codePointAt(lastOriginal)! > 0xffff ? 2 : 1)
  // The marks on the match's last letter go with it.
  while (end < flat.length && ARABIC_MARK.test(flat[end])) end++

  let from0 = Math.max(0, start - SNIPPET_BEFORE)
  let to = Math.min(flat.length, end + SNIPPET_AFTER)
  let head = flat.slice(from0, start)
  let tail = flat.slice(end, to)
  if (from0 > 0) head = cutAtSpace(head, 'start')
  if (to < flat.length) tail = cutAtSpace(tail, 'end')
  from0 = start - head.length
  to = end + tail.length
  const before = from0 > 0 ? '…' : ''
  const after = to < flat.length ? '…' : ''
  const snippet = `${before}${head}${flat.slice(start, end)}${tail}${after}`
  return { snippet, match: { start: before.length + head.length, length: end - start } }
}

/** A piece of text cut at its first (start) or last (end) space, when it has one not too near its edge. */
function cutAtSpace(piece: string, side: 'start' | 'end'): string {
  if (side === 'start') {
    const space = piece.indexOf(' ')
    return space !== -1 && space < piece.length / 2 ? piece.slice(space + 1) : piece
  }
  const space = piece.lastIndexOf(' ')
  return space > piece.length / 2 ? piece.slice(0, space) : piece
}

interface HitRow extends AiConversation {
  where: 'title' | 'question' | 'answer'
  text: string | null
}

/** The person's conversations that have the words, the latest first. */
export async function searchConversations(q: Queryable, userId: string, words: string, limit = AI_CONVERSATION_SEARCH_LIMIT): Promise<AiConversationSearchResponse> {
  const { rows } = await q.query<HitRow>(
    `SELECT ${CONVERSATION_SELECT}, hit.w AS "where", hit.txt AS "text"
       FROM ai_conversations c
       CROSS JOIN LATERAL (
         SELECT h.w, h.txt FROM (
           SELECT 0 AS rank, 'title' AS w, NULL::text AS txt WHERE ai_search_fold(c.title) LIKE $2
           UNION ALL
           (SELECT 1, CASE WHEN ai_search_fold(t.question) LIKE $2 THEN 'question' ELSE 'answer' END,
                   CASE WHEN ai_search_fold(t.question) LIKE $2 THEN t.question ELSE t.answer_text END
              FROM ai_turns t
             WHERE t.conversation_id = c.id AND (ai_search_fold(t.question) LIKE $2 OR ai_search_fold(t.answer_text) LIKE $2)
             ORDER BY t.created_at DESC LIMIT 1)
         ) h
         ORDER BY h.rank LIMIT 1
       ) hit
      WHERE c.user_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT $3`,
    [userId, likePattern(words), limit + 1],
  )
  const hits = rows.slice(0, limit).map((r): AiConversationSearchHit => {
    const conversation = toConversation(r)
    if (r.where === 'title' || r.text === null) return { conversation, where: 'title', snippet: '', match: null }
    return { conversation, where: r.where, ...snippetAround(r.text, words) }
  })
  return { hits, hasMore: rows.length > limit }
}
