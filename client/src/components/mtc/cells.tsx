// ============================================================================
// MTC — a register's value as people read it: a type by its name ("Black" for
// HR), a day as a date, a certified strength green within its grade's limits
// and red outside them, with the limit in its tooltip.
// ============================================================================

import { MTC_JUDGED_FIELDS, mtcJudge, mtcLimitText, type MtcField, type MtcJudgedField, type MtcStandard } from '@qc/shared/mtc'
import { cn, formatDay } from '@/lib/utils'

/** A field's value as text; '' for none. */
export function fieldText(f: MtcField, v: string | number | undefined): string {
  if (v === undefined || v === '') return ''
  if (f.type === 'date') return formatDay(String(v))
  if (f.choiceLabels && typeof v === 'string') return f.choiceLabels[v] ?? v
  return String(v)
}

export const isJudged = (key: string): key is MtcJudgedField => (MTC_JUDGED_FIELDS as readonly string[]).includes(key)

/** What a judged value's colour says, for its tooltip: "Within S420MC: ≥ 420 MPa". */
export function judgedTip(f: MtcField, standard: MtcStandard | undefined, v: unknown): string | undefined {
  if (!standard || !isJudged(f.key)) return undefined
  const ok = mtcJudge(standard, f.key, v)
  const limit = mtcLimitText(standard, f.key)
  if (!limit) return `${standard.grade} sets no ${f.label.toLowerCase()} limit`
  const unit = f.unit ? ` ${f.unit}` : ''
  if (ok === null) return `${standard.grade}: ${limit}${unit}`
  return `${ok ? 'Within' : 'Outside'} ${standard.grade}: ${limit}${unit}`
}

/** A certified strength, green when within its grade's limits, red when not; plain when there is nothing to judge. */
export function JudgedValue({ field, value, standard, className }: { field: MtcField; value: string | number | undefined; standard?: MtcStandard; className?: string }) {
  const ok = isJudged(field.key) ? mtcJudge(standard, field.key, value) : null
  const shown = fieldText(field, value)
  if (ok === null) return <span className={className}>{shown || '—'}</span>
  return (
    <span
      data-tip={judgedTip(field, standard, value)}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold tabular-nums',
        ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200' : 'bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200',
        className,
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-rose-500')} />
      {shown}
      <span className="sr-only">{ok ? ' (within the grade)' : ' (outside the grade: alert)'}</span>
    </span>
  )
}
