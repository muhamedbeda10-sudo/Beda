// ============================================================================
// Which way a text reads: right to left (Arabic, Hebrew) or left to right,
// decided by its letters. Used where dir="auto" cannot decide well — a text
// that opens with a code, or whose values are set apart with Unicode
// isolates, which dir="auto" passes over.
// ============================================================================

/** Letters that set a text right to left: Hebrew, Arabic and their presentation forms — not the Arabic digits, which are weak. */
const RTL_CHAR = /[֐-׿؀-ٟ٭-ۯۺ-ࣿיִ-﷿ﹰ-ﻼ]/
/** Letters that set it left to right: Latin, Greek, Cyrillic. */
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/

/** Which way a text reads, by its first strong letter — counting letters inside isolates, which dir="auto" skips; null when it has none. */
export function textDirection(text: string): 'rtl' | 'ltr' | null {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl'
    if (LTR_CHAR.test(ch)) return 'ltr'
  }
  return null
}

/** A text reads right to left when more than this share of its words do. */
const RTL_WORD_SHARE = 0.4

/**
 * Which way a message people typed reads, by its words: right to left when
 * more than 40% of its words start with a right-to-left letter (the estimate
 * Google's Closure bidi library uses). An Arabic message naming English
 * parts — "ضروري Connector welding wire في مكان اللحام" — has as many Latin
 * letters as Arabic ones, yet reads right to left. Null when it has no word
 * with a strong letter.
 */
export function messageDirection(text: string): 'rtl' | 'ltr' | null {
  let rtl = 0
  let total = 0
  for (const word of text.split(/\s+/)) {
    const first = textDirection(word)
    if (!first) continue
    total++
    if (first === 'rtl') rtl++
  }
  if (total === 0) return null
  return rtl / total > RTL_WORD_SHARE ? 'rtl' : 'ltr'
}

/** Which way most of a text's letters read; null when it has none. */
export function letterDirection(text: string): 'rtl' | 'ltr' | null {
  let rtl = 0
  let ltr = 0
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) rtl++
    else if (LTR_CHAR.test(ch)) ltr++
  }
  return rtl === 0 && ltr === 0 ? null : rtl > ltr ? 'rtl' : 'ltr'
}
