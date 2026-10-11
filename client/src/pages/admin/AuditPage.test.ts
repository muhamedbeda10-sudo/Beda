import { describe, expect, it } from 'vitest'
import { AUDIT_CHECK_PX, AUDIT_COLUMNS, AUDIT_TABLE_MIN_PX } from './AuditPage'

describe('the audit log table', () => {
  it('gives every column a width, so none is squeezed to nothing on a tablet', () => {
    for (const c of AUDIT_COLUMNS) {
      expect(c.width, c.key).toMatch(/^w-\[\d+(\.\d+)?rem\]$/)
      expect(c.rem, c.key).toBeGreaterThanOrEqual(5)
      // The class and the figure beside it say the same width.
      expect(c.width).toBe(`w-[${c.rem}rem]`)
    }
  })

  it('reads the old and new values at a width worth reading', () => {
    for (const key of ['oldValue', 'newValue']) expect(AUDIT_COLUMNS.find((c) => c.key === key)?.rem).toBeGreaterThanOrEqual(16)
  })

  it('is at least as wide as its columns and the checkbox column together, so table-fixed never takes from them', () => {
    const sum = AUDIT_COLUMNS.reduce((n, c) => n + c.rem, 0) * 16 + AUDIT_CHECK_PX
    expect(AUDIT_TABLE_MIN_PX).toBeGreaterThanOrEqual(sum)
  })
})
