import { describe, expect, it } from 'vitest'
import type { Coil } from '@qc/shared/types'
import type { MtcExtractedCoil } from '@qc/shared/mtc'
import { blankReviewRow, coilOfRow, editReviewRow, reviewRows, saveRows, summarise, toReviewRows } from './review'

const read = (c: Partial<MtcExtractedCoil> & { coilNumber: string }): MtcExtractedCoil => ({ uncertain: [], ...c })
const registered = (c: Partial<Coil> & { coilNumber: string }): Coil => ({ id: `id-${c.coilNumber}`, ...c })

describe('the MTC review', () => {
  it('holds what Claude read as the inputs show it, and reads it back as the register keeps it', () => {
    const [row] = toReviewRows([read({ coilNumber: '213417-506', grade: 'S450GD+Z275', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00', page: 2, uncertain: ['yield'] })])
    expect(row.values).toEqual({ coilNumber: '213417-506', grade: 'S450GD+Z275', smType: '', supplier: '', thickness: '3.5', width: '1285', yield: '464', notes: 'MTC 20230055086-00' })
    expect(row.uncertain).toEqual(['yield'])
    expect(row.page).toBe(2)
    expect(coilOfRow(row)).toEqual({ coilNumber: '213417-506', grade: 'S450GD+Z275', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00' })
  })

  it('clears a field’s mark of doubt once the person edits it, and reads a decimal comma', () => {
    const [row] = toReviewRows([read({ coilNumber: 'C1', yield: 357, uncertain: ['yield', 'width'] })])
    const edited = editReviewRow(row, 'yield', '367,5')
    expect(edited.uncertain).toEqual(['width'])
    expect(coilOfRow(edited).yield).toBe(367.5)
  })

  it('judges each row against the register: new, same, different, removed, twice', () => {
    const rows = toReviewRows([
      read({ coilNumber: 'NEW-1', grade: 'S315MC' }),
      read({ coilNumber: 'same-1', grade: 'S315MC', yield: 349 }),
      read({ coilNumber: 'DIFF-1', grade: 'S420MC', yield: 433 }),
      read({ coilNumber: 'GONE-1', grade: 'S235JR' }),
      read({ coilNumber: 'TWICE' }),
      read({ coilNumber: 'twice ' }),
    ])
    const reviewed = reviewRows(rows, [
      registered({ coilNumber: 'SAME-1', grade: 'S315MC', yield: 349, supplier: 'Baosteel' }),
      registered({ coilNumber: 'DIFF-1', grade: 'S355MC', yield: 380 }),
      registered({ coilNumber: 'GONE-1', grade: 'S235JR', deletedAt: '2026-10-01T00:00:00.000Z' }),
    ])
    expect(reviewed.map((r) => r.status)).toEqual(['new', 'same', 'different', 'removed', 'duplicate', 'duplicate'])
    // A blank never erases: the supplier Claude did not read is not a difference.
    expect(reviewed[1].changed).toEqual([])
    expect(reviewed[2].changed).toEqual(['grade', 'yield'])
    expect(reviewed[4].problems[0]).toMatchObject({ field: 'coilNumber', blocking: true })
  })

  it('blocks a row with no number or a measurement that is not one, and flags an unusual one', () => {
    const blank = blankReviewRow()
    const bad = editReviewRow(toReviewRows([read({ coilNumber: 'C2' })])[0], 'thickness', 'abc')
    const odd = toReviewRows([read({ coilNumber: 'C3', yield: 3550 })])[0]
    const reviewed = reviewRows([blank, bad, odd], [])
    expect(reviewed[0].problems).toContainEqual(expect.objectContaining({ field: 'coilNumber', blocking: true }))
    expect(reviewed[1].problems).toContainEqual(expect.objectContaining({ field: 'thickness', blocking: true }))
    expect(reviewed[2].problems).toEqual([expect.objectContaining({ field: 'yield', blocking: false })])
    const summary = summarise(reviewed)
    expect(summary).toMatchObject({ total: 3, blocking: 2, warnings: 1 })
  })

  it('sends only what Save changes, with the person’s choice for each registered coil', () => {
    const rows = toReviewRows([
      read({ coilNumber: 'NEW-1', grade: 'S315MC' }),
      read({ coilNumber: 'SAME-1', grade: 'S315MC' }),
      read({ coilNumber: 'DIFF-1', grade: 'S420MC' }),
      read({ coilNumber: 'DIFF-2', grade: 'S420MC' }),
    ])
    rows[2] = { ...rows[2], overwrite: true }
    const reviewed = reviewRows(rows, [
      registered({ coilNumber: 'SAME-1', grade: 'S315MC' }),
      registered({ coilNumber: 'DIFF-1', grade: 'S355MC' }),
      registered({ coilNumber: 'DIFF-2', grade: 'S355MC' }),
    ])
    expect(summarise(reviewed)).toMatchObject({ added: 1, overwritten: 1, kept: 2, different: 2, blocking: 0 })
    expect(saveRows(reviewed)).toEqual([
      { coilNumber: 'NEW-1', grade: 'S315MC', overwrite: false },
      { coilNumber: 'DIFF-1', grade: 'S420MC', overwrite: true },
      { coilNumber: 'DIFF-2', grade: 'S420MC', overwrite: false },
    ])
  })
})
