// ============================================================================
// Figures as an inspector types them.
//
// A measurement box opens the phone's number pad, and that pad follows the
// phone's language: an Arabic or Persian phone gives ٠١٢…, ۰۱۲… and the
// Arabic decimal mark ٫; a French or German one gives a comma. Each is a
// perfectly good number to the person typing it, and each made Number() say
// NaN — saved as blank, judged as a pass on screen. Everything typed goes
// through here: rewritten to Latin digits and a point as it is typed, and
// read strictly, so "0.5mm" is refused rather than half-understood. A comma
// is always the decimal mark: a measurement is never written with thousands
// separators, and "1,000.5" (two marks) is refused rather than guessed at.
// ============================================================================

/** Arabic-Indic (U+0660…) and Extended Arabic-Indic / Persian (U+06F0…) digits. */
const EASTERN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g

/** A plain decimal: an optional sign, digits with at most one point. No exponent, no hex, no unit. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/

/**
 * The text with Latin digits and a point for a decimal mark: Arabic and
 * Persian digits, the Arabic decimal separator (٫) and a comma become their
 * Latin form, a minus sign (−) a hyphen, and spaces around it go. Anything
 * else — a unit, a letter — is left as it was typed, for `parseDecimal` to
 * refuse.
 */
export function normaliseDecimal(text: string): string {
  return text
    .replace(EASTERN_DIGITS, (d) => {
      const code = d.charCodeAt(0)
      return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660))
    })
    .replace(/[\u066B,]/g, '.')
    .replace(/[\u2212\u2012\u2013]/g, '-')
    .trim()
}

/**
 * The number typed: null when nothing is, NaN when what is typed is not a
 * number. Normalised first, so a figure stored before normalising (an old
 * draft) reads the same as one typed now.
 */
export function parseDecimal(text: string | null | undefined): number | null {
  const t = normaliseDecimal(text ?? '')
  if (t === '') return null
  return DECIMAL.test(t) ? Number(t) : Number.NaN
}

/** Whether the text is blank or a number — a field to mark when it is neither. */
export function isDecimalOrBlank(text: string | null | undefined): boolean {
  const n = parseDecimal(text)
  return n === null || Number.isFinite(n)
}
