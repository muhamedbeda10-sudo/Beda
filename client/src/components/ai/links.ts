// ============================================================================
// §20 — where a link in an answer may lead. The model writes markdown, and
// what it writes can echo text people typed into the record, so a link is
// trusted only as far as its shape: a page of this application (opened in
// place, e.g. a session in History) or a plain web address (opened in a new
// tab). Anything else — javascript:, data:, mailto:, a protocol-relative
// //host — is dropped and its words shown as text.
// ============================================================================

export type AiLink = { kind: 'app'; to: string } | { kind: 'external'; href: string }

/** A stand-in origin for resolving app paths: whatever leaves it was never a path of this app. */
const APP = 'https://app.invalid'

export function classifyAiLink(href: string | null | undefined): AiLink | null {
  if (!href) return null
  const raw = href.trim()
  // Control characters and backslashes have no place in a link the model writes; browsers read "\" as "/".
  // eslint-disable-next-line no-control-regex
  if (raw === '' || /[\u0000-\u001f\u007f\\]/.test(raw)) return null
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return null
    let url: URL
    try {
      url = new URL(raw, APP)
    } catch {
      return null
    }
    // Dot segments ("/..//evil.example", "/%2e%2e//evil.example") resolve to a path that starts "//":
    // as an href, that is another site. The path is judged as resolved, not as written.
    const to = `${url.pathname}${url.search}${url.hash}`
    if (url.origin !== APP || to.startsWith('//')) return null
    return { kind: 'app', to }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // A user name in a link ("https://linkmisr.com@evil.example") only serves to mislead.
  if (url.username || url.password) return null
  return { kind: 'external', href: url.href }
}

/** react-markdown's urlTransform: the address kept as written when it may be followed, emptied when not. */
export function aiUrlTransform(url: string): string {
  return classifyAiLink(url) ? url : ''
}
