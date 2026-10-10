// ============================================================================
// §21 — the addresses in what the automations sender writes ("QC
// Automations"): a case's follow-up, its session, a delivered report, the
// automation's run history. Each is a path of this app written as text;
// these turn them into links that open in place, named for what they open.
// Only a path that starts at a page of the app and stays inside it is ever a
// link — anything else stays text.
// ============================================================================

import { appPath } from '@/lib/links'

export type LinkSegment = { type: 'text'; text: string } | { type: 'link'; to: string; label: string }

/** The app's sections a written path may lead to. */
const SECTIONS = ['follow-ups', 'history', 'automations', 'chat', 'ai', 'dashboard', 'access', 'pdi', 'coils']

/** A path at the start of the text or after a space or an opening bracket, up to the next space. */
const PATH_RE = new RegExp(`(^|[\\s(\\[])(\\/(?:${SECTIONS.join('|')})(?:[/?#][^\\s<>"'\`]*)?)`, 'g')

/** Punctuation that ends a sentence after a path rather than belonging to it. */
const TRAILING = /[.,;:!?)\]]+$/

/** What a link to a path is called: what it opens, in words. */
export function appLinkLabel(path: string): string {
  const url = new URL(path, 'https://app.invalid')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 'follow-ups') return parts[1] ? 'Open the follow-up' : 'Open follow-ups'
  if (parts[0] === 'automations') {
    if (parts[1] === 'deliveries' && parts[2]) return 'Open the report'
    return parts[1] ? 'Open the automation' : 'Open automations'
  }
  if (parts[0] === 'history') {
    if (url.searchParams.get('sample')) return 'Open the sample'
    if (url.searchParams.get('session')) return 'Open the session'
    if (url.searchParams.get('q')) return 'Open the order in History'
    return 'Open History'
  }
  return path
}

/** A text with the app's paths in it as links, in order; text without one comes back whole. */
export function appLinkSegments(text: string): LinkSegment[] {
  const out: LinkSegment[] = []
  let last = 0
  const push = (t: string) => {
    if (!t) return
    const prev = out.at(-1)
    if (prev?.type === 'text') prev.text += t
    else out.push({ type: 'text', text: t })
  }
  for (const m of text.matchAll(PATH_RE)) {
    const start = (m.index ?? 0) + m[1].length
    const written = m[2].replace(TRAILING, '')
    const to = appPath(written)
    push(text.slice(last, start))
    if (to) out.push({ type: 'link', to, label: appLinkLabel(to) })
    else push(written)
    last = start + written.length
  }
  push(text.slice(last))
  return out
}
