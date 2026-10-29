import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deliveryNoteStatus } from '@qc/shared/receiving'
import { TestApp } from './harness'
import { factoryDataSql } from './perf/factoryData'

// §27 — the figures receiving keeps (migration 0091): a delivery note's lines
// by decision and its coils, and its state; a PO line's delivered, accepted,
// rejected, hold and pending quantities over the notes not deleted. They are
// always what the rows say, after every kind of change: lines added, decided,
// re-decided, removed and moved to another note; coils added and removed; a
// note deleted and restored. And the screen's own working of the state agrees.

let app: TestApp

beforeAll(async () => {
  app = await new TestApp().start()
  await app.resetDatabase()
  await app.db.query(factoryDataSql(300))
})
afterAll(() => app.stop())

const NOTES_THEN = `
SELECT d.id, count(l.id)::int AS lines, count(l.id) FILTER (WHERE l.status = 'pending')::int AS pending, count(l.id) FILTER (WHERE l.status = 'hold')::int AS hold,
       count(l.id) FILTER (WHERE l.status = 'accepted')::int AS accepted, count(l.id) FILTER (WHERE l.status = 'partial')::int AS partial,
       count(l.id) FILTER (WHERE l.status = 'rejected')::int AS rejected, (SELECT count(*)::int FROM receiving_note_coils c WHERE c.note_id = d.id) AS coils
  FROM receiving_notes d LEFT JOIN receiving_note_lines l ON l.note_id = d.id GROUP BY d.id`
const NOTES_NOW = `SELECT id, lines, pending_lines, hold_lines, accepted_lines, partial_lines, rejected_lines, coils FROM receiving_notes`
const LINES_THEN = `
SELECT p.id, COALESCE(sum(l.quantity), 0)::float8 AS delivered, COALESCE(sum(l.accepted_qty), 0)::float8 AS accepted, COALESCE(sum(l.rejected_qty), 0)::float8 AS rejected,
       COALESCE(sum(l.quantity) FILTER (WHERE l.status = 'hold'), 0)::float8 AS hold, COALESCE(sum(l.quantity) FILTER (WHERE l.status = 'pending'), 0)::float8 AS pending
  FROM purchase_order_lines p
  LEFT JOIN (receiving_note_lines l JOIN receiving_notes d ON d.id = l.note_id AND d.deleted_at IS NULL) ON l.po_line_id = p.id GROUP BY p.id`
const LINES_NOW = `SELECT id, delivered_qty::float8, accepted_qty::float8, rejected_qty::float8, hold_qty::float8, pending_qty::float8 FROM purchase_order_lines`

async function same(): Promise<void> {
  for (const [then, now] of [[NOTES_THEN, NOTES_NOW], [LINES_THEN, LINES_NOW]]) {
    for (const [a, b] of [[then, now], [now, then]]) {
      const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ((${a}) EXCEPT ALL (${b})) d`)
      expect(rows[0].n).toBe(0)
    }
  }
  const { rows } = await app.db.query<{ status: string; pending: number; hold: number; closed: boolean }>(`SELECT status, pending_lines AS pending, hold_lines AS hold, closed_at IS NOT NULL AS closed FROM receiving_notes`)
  for (const r of rows) expect(deliveryNoteStatus(r, r.closed)).toBe(r.status)
}

describe('§27 receiving’s figures are its rows’', () => {
  it('after the record is made', async () => {
    const { rows } = await app.db.query<{ n: number; s: number }>(`SELECT count(*)::int AS n, count(DISTINCT status)::int AS s FROM receiving_notes WHERE lines > 0`)
    expect(rows[0].n).toBeGreaterThan(20)
    expect(rows[0].s).toBeGreaterThan(1)
    await same()
  })

  it('after lines are decided, re-decided, added, removed and moved', async () => {
    await app.db.query(`UPDATE receiving_note_lines SET status = 'accepted', accepted_qty = quantity, rejected_qty = 0, hold_reason = '', reject_reason = '', decided_at = now()
      WHERE id IN (SELECT id FROM receiving_note_lines WHERE status IN ('pending', 'hold') ORDER BY id LIMIT 10)`)
    await same()
    await app.db.query(`UPDATE receiving_note_lines SET status = 'hold', accepted_qty = NULL, rejected_qty = NULL, hold_reason = 'Missing samples', reject_reason = ''
      WHERE id IN (SELECT id FROM receiving_note_lines WHERE status = 'accepted' ORDER BY id DESC LIMIT 5)`)
    await same()
    await app.db.query(`UPDATE receiving_note_lines SET quantity = quantity + 5 WHERE status IN ('pending', 'hold')`)
    await same()
    await app.db.query(`DELETE FROM receiving_note_lines WHERE id IN (SELECT id FROM receiving_note_lines WHERE status = 'pending' ORDER BY id LIMIT 4)`)
    await same()
    await app.db.query(`INSERT INTO receiving_note_lines (note_id, po_line_id, position, quantity)
      SELECT d.id, l.id, 4, 7 FROM receiving_notes d JOIN purchase_order_lines l ON l.po_id = d.po_id AND l.line_no = 4 ORDER BY d.id LIMIT 6`)
    await same()
    // Moved to another note of the same PO, and to another PO line.
    await app.db.query(`UPDATE receiving_note_lines SET note_id = x.other FROM (
        SELECT l.id, (SELECT d2.id FROM receiving_notes d2 WHERE d2.po_id = d.po_id AND d2.id <> d.id LIMIT 1) AS other
          FROM receiving_note_lines l JOIN receiving_notes d ON d.id = l.note_id WHERE l.position = 4 ORDER BY l.id LIMIT 3) x
      WHERE receiving_note_lines.id = x.id AND x.other IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM receiving_note_lines y WHERE y.note_id = x.other AND y.po_line_id = receiving_note_lines.po_line_id)`)
    await same()
    await app.db.query(`UPDATE receiving_note_lines SET po_line_id = (SELECT id FROM purchase_order_lines ORDER BY id LIMIT 1)
      WHERE id = (SELECT id FROM receiving_note_lines WHERE status = 'pending' ORDER BY id DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM receiving_note_lines y WHERE y.note_id = receiving_note_lines.note_id AND y.po_line_id = (SELECT id FROM purchase_order_lines ORDER BY id LIMIT 1))`)
    await same()
  })

  it('after coils are added and removed, and a note closed, deleted and restored', async () => {
    await app.db.query(`INSERT INTO receiving_note_coils (note_id, position, coil_number) SELECT id, 99, 'NEW-' || reference FROM receiving_notes ORDER BY id LIMIT 8`)
    await same()
    await app.db.query(`DELETE FROM receiving_note_coils WHERE position IN (1, 99) AND note_id IN (SELECT id FROM receiving_notes ORDER BY id LIMIT 12)`)
    await same()
    await app.db.query(`UPDATE receiving_notes SET closed_at = now() WHERE id IN (SELECT id FROM receiving_notes WHERE status = 'decided' ORDER BY id LIMIT 3)`)
    await same()
    await app.db.query(`UPDATE receiving_notes SET deleted_at = now() WHERE id IN (SELECT id FROM receiving_notes ORDER BY id LIMIT 7)`)
    await same()
    await app.db.query(`UPDATE receiving_notes SET deleted_at = NULL WHERE id IN (SELECT id FROM receiving_notes WHERE deleted_at IS NOT NULL ORDER BY id LIMIT 3)`)
    await same()
  })

  it('never lets a decided line leave its note, nor a decision without its reason', async () => {
    await expect(app.db.query(`DELETE FROM receiving_note_lines WHERE id = (SELECT id FROM receiving_note_lines WHERE status = 'accepted' LIMIT 1)`)).rejects.toThrow(/decided delivery line/)
    await expect(app.db.query(`UPDATE receiving_note_lines SET status = 'rejected', accepted_qty = 0, rejected_qty = quantity, reject_reason = '', decided_at = now()
      WHERE id = (SELECT id FROM receiving_note_lines LIMIT 1)`)).rejects.toThrow(/receiving_note_lines_reasons/)
    await expect(app.db.query(`UPDATE receiving_note_lines SET status = 'partial', accepted_qty = quantity, rejected_qty = 1, reject_reason = 'x', decided_at = now()
      WHERE id = (SELECT id FROM receiving_note_lines LIMIT 1)`)).rejects.toThrow(/receiving_note_lines_quantities/)
  })
})
