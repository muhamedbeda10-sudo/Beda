// The mention tokens a message body carries (§17). The API stores them as
// written; the screen turns them into chips and back.

import type { ChatMentionKind } from '@qc/shared/types'

export const MENTION_RE = /([@#])\[([^\]\n]{1,120})\]\((user|order|item|machine|session):([^)\s]{1,120})\)/g

export type Segment = { type: 'text'; text: string } | { type: 'mention'; sigil: '@' | '#'; kind: ChatMentionKind; value: string; label: string }

export function segments(body: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of body.matchAll(MENTION_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', text: body.slice(last, at) })
    out.push({ type: 'mention', sigil: m[1] as '@' | '#', kind: m[3] as ChatMentionKind, value: m[4], label: m[2] })
    last = at + m[0].length
  }
  if (last < body.length) out.push({ type: 'text', text: body.slice(last) })
  return out
}

export function mentionToken(kind: ChatMentionKind, value: string, label: string): string {
  const sigil = kind === 'user' ? '@' : '#'
  return `${sigil}[${label.replace(/[\]\n]/g, ' ').slice(0, 120)}](${kind}:${value.replace(/[)\s]/g, '').slice(0, 120)})`
}

export function plainText(body: string): string {
  return body.replace(MENTION_RE, (_, sigil: string, label: string) => `${sigil}${label}`)
}

/**
 * The trigger being typed at the caret: "@moh" or "#2009", or null. A
 * trigger starts at the beginning or after whitespace and has no space in
 * it; a finished token (…](…)) is never a trigger.
 */
export function triggerAt(text: string, caret: number): { sigil: '@' | '#'; query: string; start: number } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)([@#])([^\s@#[\]()]{0,60})$/.exec(before)
  if (!m) return null
  const start = caret - m[2].length - m[3].length
  return { sigil: m[2] as '@' | '#', query: m[3], start }
}
