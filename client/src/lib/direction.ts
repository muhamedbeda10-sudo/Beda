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
