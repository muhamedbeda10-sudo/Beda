// ============================================================================
// The wizard's small decisions that do not need a screen to be checked: which
// tested lengths go with the sample, what an issue about one is called,
// whether the on-screen keyboard is up, what a dimension's figures are and how
// it reads before it is saved, whether a grade acknowledgement still holds,
// and what to show when the session could not be (re)loaded.
// ============================================================================

import { dimensionStatus, findGradeMismatches, normaliseGrade } from '@qc/shared/rules'
import type { DimensionStatus } from '@qc/shared/types'
import { ApiError } from '@/lib/api'
import { parseDecimal } from '@/lib/decimal'
import type { DraftDimension, DraftTestedLength, SampleDraft } from '@/services/draftStore'

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

// ---- A dimension's figures -------------------------------------------------

/** A dimension's figures as they are saved: null where blank, NaN where what is typed is not a number. */
export interface DimensionFigures {
  nominal: number | null
  tolPlus: number | null
  tolMinus: number | null
  actual: number | null
}

/** The figures of a draft row, read the one way the save, the checks and the preview all read them. */
export function dimensionFigures(d: Pick<DraftDimension, 'nominal' | 'tolPlus' | 'tolMinus' | 'actual'>): DimensionFigures {
  return { nominal: parseDecimal(d.nominal), tolPlus: parseDecimal(d.tolPlus), tolMinus: parseDecimal(d.tolMinus), actual: parseDecimal(d.actual) }
}

/** Whether any figure of the row is typed but not a number. */
export function hasBadFigure(f: DimensionFigures): boolean {
  return Object.values(f).some((v) => v !== null && !Number.isFinite(v))
}

/**
 * How a row reads before it is saved — what the server will store for it: a
 * blank nominal, tolerance or actual is Pending there, so it is here (a blank
 * read as 0 showed Fail where the record says Pending). A figure that is not a
 * number cannot be judged either; the field says so and the save is refused.
 */
export function previewStatus(d: Pick<DraftDimension, 'nominal' | 'tolPlus' | 'tolMinus' | 'actual'>): DimensionStatus {
  const f = dimensionFigures(d)
  if (hasBadFigure(f)) return 'Pending'
  return dimensionStatus(f)
}

// ---- §8.4 The grade acknowledgement ----------------------------------------

type Acknowledgement = NonNullable<SampleDraft['gradeAcknowledged']>

/** One coil's mismatch as compared: its number and its grade, written the one way. */
const mismatchKey = (coilNumber: string, grade: string) => `${coilNumber.trim().toLowerCase()}\u0000${normaliseGrade(grade)}`

/**
 * The acknowledgement that goes with the save: the one on the draft, but only
 * while it names exactly the mismatches the coils have now — the same coils
 * with the same grades, against the same expected grade. Anything else (a coil
 * added, removed or changed since; an equivalence configured meanwhile) is not
 * what the person acknowledged, so they are asked again. With no mismatch there
 * is nothing to acknowledge and none is sent.
 */
export function coveringAcknowledgement(
  ack: SampleDraft['gradeAcknowledged'],
  expectedGrade: string,
  coils: SampleDraft['coils'],
  gradeIndex: Map<string, string>,
): Acknowledgement | undefined {
  const mismatches = findGradeMismatches(expectedGrade, coils, gradeIndex)
  if (!ack || mismatches.length === 0) return undefined
  if (normaliseGrade(ack.expectedGrade) !== normaliseGrade(expectedGrade)) return undefined
  if (ack.coilNumbers.length !== ack.foundGrades.length) return undefined
  const acknowledged = ack.coilNumbers.map((c, i) => mismatchKey(c, ack.foundGrades[i])).sort()
  const now = mismatches.map((m) => mismatchKey(m.coilNumber, m.coilGrade)).sort()
  return acknowledged.length === now.length && acknowledged.every((k, i) => k === now[i]) ? ack : undefined
}

/**
 * A change to the draft, with the rule that any change to its coils — one
 * added, removed or edited — lets go of the grade acknowledgement: it was given
 * for the coils as they were.
 */
export function withCoilRule(cur: SampleDraft, next: SampleDraft): SampleDraft {
  if (next.coils === cur.coils || !next.gradeAcknowledged || next.gradeAcknowledged !== cur.gradeAcknowledged) return next
  return { ...next, gradeAcknowledged: undefined }
}

// ---- Loading the session ---------------------------------------------------

/**
 * What the wizard shows for its session's context:
 * - `ready`: drawn from what is loaded;
 * - `stale`: drawn from what was loaded, a later refresh having failed (a dead
 *   network on the floor) — the inspector keeps working (§9.6), told quietly;
 * - `not-found`: the server says the session is not there (404), whether or not
 *   it was loaded before — it was discarded or deleted meanwhile;
 * - `failed`: nothing loaded and the server could not be asked.
 */
export type WizardLoadState = 'ready' | 'stale' | 'not-found' | 'failed'

export function wizardLoadState(hasData: boolean, error: unknown): WizardLoadState {
  if (error instanceof ApiError && error.status === 404) return 'not-found'
  if (!hasData) return error ? 'failed' : 'not-found'
  return error ? 'stale' : 'ready'
}
