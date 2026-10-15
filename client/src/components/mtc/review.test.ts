import { describe, expect, it } from 'vitest'
import { MTC_REGISTERS, type MtcExtractedRow, type MtcRegisterRow, type MtcValues } from '@qc/shared/mtc'
import { blankReviewRow, editReviewRow, reviewRows, saveRows, summarise, toReviewRows, valuesOfRow } from './review'

const COILS = MTC_REGISTERS.coils
const MESH = MTC_REGISTERS['mesh-wire']
const WELD = MTC_REGISTERS['welding-wire']
const read = (values: MtcValues, uncertain: string[] = [], page?: number): MtcExtractedRow => ({ values, uncertain, ...(page ? { page } : {}) })
const registered = (values: MtcValues, deletedAt?: string): MtcRegisterRow => ({ id: `id-${Object.values(values).join('-')}`, values, ...(deletedAt ? { deletedAt } : {}) })

describe('the MTC review', () => {
  it('holds what Claude read as the inputs show it, and reads it back as the register keeps it', () => {
    const [row] = toReviewRows(COILS, [read({ coilNumber: '213417-506', grade: 'S450GD+Z275', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00' }, ['yield'], 2)])
    expect(row.values).toEqual({ coilNumber: '213417-506', grade: 'S450GD+Z275', smType: '', supplier: '', thickness: '3.5', width: '1285', yield: '464', notes: 'MTC 20230055086-00' })
    expect(row.uncertain).toEqual(['yield'])
    expect(row.page).toBe(2)
    expect(valuesOfRow(COILS, row)).toEqual({ coilNumber: '213417-506', grade: 'S450GD+Z275', thickness: 3.5, width: 1285, yield: 464, notes: 'MTC 20230055086-00' })
  })

  it('clears a field’s mark of doubt once the person edits it, and reads a decimal comma', () => {
    const [row] = toReviewRows(WELD, [read({ batchNumber: '22285', yield: 485 }, ['yield', 'weightKg'])])
    const edited = editReviewRow(row, 'yield', '485,5')
    expect(edited.uncertain).toEqual(['weightKg'])
    expect(valuesOfRow(WELD, edited).yield).toBe(485.5)
  })

  it('judges each coil against the register: new, same, different, removed, twice', () => {
    const rows = toReviewRows(COILS, [
      read({ coilNumber: 'NEW-1', grade: 'S315MC' }),
      read({ coilNumber: 'same-1', grade: 'S315MC', yield: 349 }),
      read({ coilNumber: 'DIFF-1', grade: 'S420MC', yield: 433 }),
      read({ coilNumber: 'GONE-1', grade: 'S235JR' }),
      read({ coilNumber: 'TWICE' }),
      read({ coilNumber: 'twice ' }),
    ])
    const reviewed = reviewRows(COILS, rows, [
      registered({ coilNumber: 'SAME-1', grade: 'S315MC', yield: 349, supplier: 'Baosteel' }),
      registered({ coilNumber: 'DIFF-1', grade: 'S355MC', yield: 380 }),
      registered({ coilNumber: 'GONE-1', grade: 'S235JR' }, '2026-10-01T00:00:00.000Z'),
    ])
    expect(reviewed.map((r) => r.status)).toEqual(['new', 'same', 'different', 'removed', 'duplicate', 'duplicate'])
    // A blank never erases: the supplier Claude did not read is not a difference.
    expect(reviewed[1].changed).toEqual([])
    expect(reviewed[2].changed).toEqual(['grade', 'yield'])
    expect(reviewed[4].problems[0]).toMatchObject({ field: 'coilNumber', blocking: true })
  })

  it('tells mesh wires apart by cast and diameter: a cast drawn to two diameters is two wires', () => {
    const rows = toReviewRows(MESH, [read({ castNumber: '62920', diameter: 3.9, tensile: 658 }), read({ castNumber: '62920', diameter: 4.8, tensile: 652 })])
    const reviewed = reviewRows(MESH, rows, [registered({ castNumber: '62920', diameter: 3.9, tensile: 640 })])
    expect(reviewed.map((r) => r.status)).toEqual(['different', 'new'])
    // Without its diameter a mesh wire cannot be matched, or saved.
    const noDiameter = reviewRows(MESH, toReviewRows(MESH, [read({ castNumber: '701688', tensile: 690 }, ['diameter'])]), [])
    expect(noDiameter[0].problems).toContainEqual(expect.objectContaining({ field: 'diameter', blocking: true }))
  })

  it('blocks a row with no identifier or a measurement that is not one, and flags an unusual one', () => {
    const blank = blankReviewRow(COILS)
    const bad = editReviewRow(toReviewRows(COILS, [read({ coilNumber: 'C2' })])[0], 'thickness', 'abc')
    const odd = toReviewRows(COILS, [read({ coilNumber: 'C3', yield: 3550 })])[0]
    const reviewed = reviewRows(COILS, [blank, bad, odd], [])
    expect(reviewed[0].problems).toContainEqual(expect.objectContaining({ field: 'coilNumber', blocking: true }))
    expect(reviewed[1].problems).toContainEqual(expect.objectContaining({ field: 'thickness', blocking: true }))
    expect(reviewed[2].problems).toEqual([expect.objectContaining({ field: 'yield', blocking: false })])
    expect(summarise(reviewed)).toMatchObject({ total: 3, blocking: 2, warnings: 1 })
  })

  it('sends only what Save changes, with the person’s choice for each registered item', () => {
    const rows = toReviewRows(COILS, [
      read({ coilNumber: 'NEW-1', grade: 'S315MC' }),
      read({ coilNumber: 'SAME-1', grade: 'S315MC' }),
      read({ coilNumber: 'DIFF-1', grade: 'S420MC' }),
      read({ coilNumber: 'DIFF-2', grade: 'S420MC' }),
    ])
    rows[2] = { ...rows[2], overwrite: true }
    const reviewed = reviewRows(COILS, rows, [
      registered({ coilNumber: 'SAME-1', grade: 'S315MC' }),
      registered({ coilNumber: 'DIFF-1', grade: 'S355MC' }),
      registered({ coilNumber: 'DIFF-2', grade: 'S355MC' }),
    ])
    expect(summarise(reviewed)).toMatchObject({ added: 1, overwritten: 1, kept: 2, different: 2, blocking: 0 })
    expect(saveRows(reviewed)).toEqual([
      { values: { coilNumber: 'NEW-1', grade: 'S315MC' }, overwrite: false },
      { values: { coilNumber: 'DIFF-1', grade: 'S420MC' }, overwrite: true },
      { values: { coilNumber: 'DIFF-2', grade: 'S420MC' }, overwrite: false },
    ])
  })
})
