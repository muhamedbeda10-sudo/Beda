// ============================================================================
// The ERP's status of an order line. A withdrawn line is "Cancel" in the
// access sheet, but exports and hand-kept sheets also write "Cancelled",
// "Canceled", "CANCEL" or the Arabic "ملغي" / "إلغاء". Every one of them is a
// cancelled line: kept for history, never offered for an inspection or a PDI.
// ============================================================================

/** SQL true when the status in `column` is a cancelled line, whichever way it is written. */
export function cancelledSql(column: string): string {
  return `(lower(btrim(${column})) LIKE 'cancel%' OR ${column} LIKE '%ملغ%' OR ${column} LIKE '%لغاء%')`
}

/** The same test in code, for a status already read. */
export function isCancelledStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').trim()
  return s.toLowerCase().startsWith('cancel') || s.includes('ملغ') || s.includes('لغاء')
}
