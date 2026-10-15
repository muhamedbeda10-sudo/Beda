// ============================================================================
// MTC — where each register lives in the database: its table and the column
// behind each field of its description (shared/src/mtc.ts). Every name that
// goes into SQL comes from here, never from a request.
// ============================================================================

import { MTC_REGISTERS, type MtcKind, type MtcRegister } from '@qc/shared/mtc'

export interface RegisterTable {
  register: MtcRegister
  table: string
  /** Field key → column. */
  columns: Readonly<Record<string, string>>
}

export const REGISTER_TABLES: Readonly<Record<MtcKind, RegisterTable>> = {
  coils: {
    register: MTC_REGISTERS.coils,
    table: 'coils',
    columns: {
      coilNumber: 'coil_number',
      grade: 'grade',
      smType: 'sm_type',
      supplier: 'supplier',
      thickness: 'thickness',
      width: 'width',
      yield: 'yield',
      notes: 'notes',
    },
  },
  'welding-wire': {
    register: MTC_REGISTERS['welding-wire'],
    table: 'welding_wires',
    columns: {
      batchNumber: 'batch_number',
      classification: 'classification',
      wireType: 'wire_type',
      diameter: 'diameter',
      supplier: 'supplier',
      weightKg: 'weight_kg',
      yield: 'yield',
      tensile: 'tensile',
      notes: 'notes',
    },
  },
  'mesh-wire': {
    register: MTC_REGISTERS['mesh-wire'],
    table: 'mesh_wires',
    columns: {
      castNumber: 'cast_number',
      diameter: 'diameter',
      product: 'product',
      grade: 'grade',
      supplier: 'supplier',
      tensile: 'tensile',
      notes: 'notes',
    },
  },
}

/** A column as SQL reads it: a quoted name, never interpolated from input. */
export const col = (t: RegisterTable, field: string): string => {
  const c = t.columns[field]
  if (!c) throw new Error(`[mtc] ${t.table} has no column for ${field}`)
  return `"${c}"`
}

/** The register's fields as one JSON object per row, keyed by field: what the API returns. */
export const valuesSql = (t: RegisterTable): string =>
  `jsonb_strip_nulls(jsonb_build_object(${t.register.fields.map((f) => `'${f.key}', ${col(t, f.key)}`).join(', ')}))`

/** id, values, deletedAt: a row as MtcRegisterRow. */
export const rowSql = (t: RegisterTable): string => `id, ${valuesSql(t)} AS "values", deleted_at AS "deletedAt"`
