// ============================================================================
// The wizard's small decisions that do not need a screen to be checked: which
// tested lengths go with the sample, what an issue about one is called, and
// whether the on-screen keyboard is up.
// ============================================================================

import type { DraftTestedLength } from '@/services/draftStore'

/**
 * A wide screen with little height: a tablet on its side, a laptop. The
 * wizard's header material folds into one strip there, so the step's first
 * field is on the first screen.
 */
export const SHORT_LANDSCAPE = '(min-width: 1024px) and (max-height: 900px)'

/** A tested-length row the inspector added and never filled: no length typed, no verdict chosen. */
export function isBlankLength(l: Pick<DraftTestedLength, 'lengthMm' | 'verdict'>): boolean {
  return l.lengthMm.trim() === '' && !l.verdict
}

/**
 * The tested lengths that go with the sample, and where each stood on the
 * screen. A blank row — "Add length" tapped once too often — is left out, the
 * way an empty extra paint reading is: it asks nothing of the inspector and is
 * not saved. `rowOf[i]` is the 1-based row number the i-th kept length has on
 * the screen.
 */
export function keptLengths<T extends Pick<DraftTestedLength, 'lengthMm' | 'verdict'>>(lengths: readonly T[]): { kept: T[]; rowOf: number[] } {
  const kept: T[] = []
  const rowOf: number[] = []
  lengths.forEach((l, i) => {
    if (isBlankLength(l)) return
    kept.push(l)
    rowOf.push(i + 1)
  })
  return { kept, rowOf }
}

/**
 * The rules number a tested length by its place in the list they were given
 * ("Tested length 2 …", ref "length-2"). With blank rows left out, that place
 * can differ from the row the inspector sees, so each such issue is named by
 * its row on the screen instead. Other issues pass through unchanged.
 */
export function renumberLengthIssues<I extends { message: string; ref?: string }>(issues: readonly I[], rowOf: readonly number[]): I[] {
  return issues.map((issue) => {
    const m = /^length-(\d+)$/.exec(issue.ref ?? '')
    if (!m) return issue
    const given = Number(m[1])
    const row = rowOf[given - 1]
    if (!row || row === given) return issue
    return {
      ...issue,
      ref: `length-${row}`,
      message: issue.message.replace(new RegExp(`(tested length )${given}(?!\\d)`, 'i'), `$1${row}`),
    }
  })
}

/** How much of the window the visible area may lose before the loss is taken for the keyboard. */
export const KEYBOARD_SHARE = 0.75

/**
 * Whether the on-screen keyboard is most likely up: a finger is the pointer,
 * a text field has the focus, and the visible area is well short of the
 * tallest the window has been at this width. The tallest, not the current
 * window: where the keyboard resizes the page (Android) the window shrinks
 * with it; where it only covers the page (iOS) the visual viewport does.
 */
export function keyboardLikelyOpen({ visible, tallest, editing, coarse }: { visible: number; tallest: number; editing: boolean; coarse: boolean }): boolean {
  return coarse && editing && tallest > 0 && visible < tallest * KEYBOARD_SHARE
}

const NO_KEYBOARD = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** Whether focus on `el` brings up a keyboard: a text box, a text area or an editable region. */
export function opensKeyboard(el: { tagName: string; type?: string; isContentEditable?: boolean; readOnly?: boolean } | null | undefined): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return !el.readOnly
  if (tag === 'input') return !el.readOnly && !NO_KEYBOARD.has((el.type ?? 'text').toLowerCase())
  return false
}
