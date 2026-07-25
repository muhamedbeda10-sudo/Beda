import { describe, it, expect } from 'vitest'
import {
  decodeChoice,
  decodeRoute,
  decodeOrderStatus,
  extractGrade,
  legacyUid,
  SESSION_STATUS,
  SHIFT,
  DIMENSION_STATUS,
  DEFECT_STATUS,
  AUDIT_ACTION,
  transformOrder,
  transformMachine,
  transformSession,
  transformSample,
  transformDimensionResult,
  transformDefectResult,
  transformAuditLog,
  transformGradeMapping,
} from './qc-dryrun.mjs'

function ctx(extra = {}) {
  const failures = []
  const counts = {}
  return {
    failures,
    counts,
    decodeFailure: (f, id) => failures.push({ ...f, id }),
    count: (k) => (counts[k] = (counts[k] ?? 0) + 1),
    ...extra,
  }
}

describe('choice decoding', () => {
  it('decodes session status from its own numbering, which starts at ...002', () => {
    expect(decodeChoice(SESSION_STATUS, 'f', 898710002).value).toBe('Open')
    expect(decodeChoice(SESSION_STATUS, 'f', 898710003).value).toBe('Closed')
  })

  it('does not let the session numbering leak into other columns', () => {
    // 898710002 means Night for shift and Warning for a dimension — the same
    // number, three different meanings. This is the trap the guide warned about.
    expect(decodeChoice(SHIFT, 'f', 898710002).value).toBe('C')
    expect(decodeChoice(DIMENSION_STATUS, 'f', 898710002).value).toBe('Warning')
    expect(decodeChoice(SESSION_STATUS, 'f', 898710000).failure).toBeTruthy()
  })

  it('decodes every shift', () => {
    expect(decodeChoice(SHIFT, 'f', 898710000).value).toBe('A')
    expect(decodeChoice(SHIFT, 'f', 898710001).value).toBe('B')
    expect(decodeChoice(SHIFT, 'f', 898710002).value).toBe('C')
  })

  it('decodes every disposition, matching this system spelling', () => {
    expect(decodeChoice(DEFECT_STATUS, 'f', 898710000).value).toBe('Rejected')
    expect(decodeChoice(DEFECT_STATUS, 'f', 898710001).value).toBe('Hold')
    expect(decodeChoice(DEFECT_STATUS, 'f', 898710002).value).toBe('Repair')
    expect(decodeChoice(DEFECT_STATUS, 'f', 898710003).value).toBe('Used in another order')
    expect(decodeChoice(DEFECT_STATUS, 'f', 898710004).value).toBe('Accept with concession')
  })

  it('treats a null choice as the fallback, not a failure', () => {
    const r = decodeChoice(DIMENSION_STATUS, 'f', null, 'Pending')
    expect(r.value).toBe('Pending')
    expect(r.failure).toBeUndefined()
  })

  it('reports an unknown value instead of guessing', () => {
    const r = decodeChoice(SHIFT, 'cr863_shift', 898710099)
    expect(r.value).toBeUndefined()
    expect(r.failure.reason).toMatch(/not present/)
  })

  it('has only Update and Delete for audit actions — Create does not exist', () => {
    expect(decodeChoice(AUDIT_ACTION, 'f', 898710000).value).toBe('update')
    expect(decodeChoice(AUDIT_ACTION, 'f', 898710001).value).toBe('delete')
    expect(Object.values(AUDIT_ACTION)).not.toContain('create')
  })
})

describe('route and order status', () => {
  it('accepts all three routes and normalises case', () => {
    expect(decodeRoute('Local').value).toBe('Local')
    expect(decodeRoute('local').value).toBe('Local')
    expect(decodeRoute('Export').value).toBe('Export')
    expect(decodeRoute('Export-KS').value).toBe('Export-KS')
  })

  it('passes null through and reports anything unexpected', () => {
    expect(decodeRoute(null).value).toBeNull()
    expect(decodeRoute('Somewhere').failure).toBeTruthy()
  })

  it('reads order status from accessstatus, the column that is actually populated', () => {
    expect(decodeOrderStatus('Active').value).toBe('Active')
    expect(decodeOrderStatus('Cancel').value).toBe('Cancel')
    expect(decodeOrderStatus('Hold').value).toBe('Hold')
    expect(decodeOrderStatus('Stock').value).toBe('Stock')
    expect(decodeOrderStatus(null).value).toBeNull()
    expect(decodeOrderStatus('Nonsense').failure).toBeTruthy()
  })
})

describe('grade extraction', () => {
  it('takes the fourth segment of the five-segment form', () => {
    expect(extractGrade('RM.ST.CO.PRG. : 298 : 2.4 : S420GD+Z275MAC : ZCL')).toBe('S420GD+Z275MAC')
    expect(extractGrade('RM.ST.CO.PRG. : 1250 : 2.0 : S315MC : ZCL')).toBe('S315MC')
  })

  it('returns null for anything that is not the five-segment form', () => {
    expect(extractGrade(null)).toBeNull()
    expect(extractGrade('')).toBeNull()
    expect(extractGrade('some free text')).toBeNull()
    expect(extractGrade('A : B : C')).toBeNull()
    expect(extractGrade('A : B : C : D : E : F')).toBeNull()
  })

  it('never invents a grade when the description is absent', () => {
    const c = ctx()
    const { doc } = transformOrder({ cr863_productionorder1id: 'o1' }, c)
    expect(doc.expectedGrade).toBe('')
    expect(c.counts.gradeUnavailable).toBe(1)
  })
})

describe('production order', () => {
  const row = {
    cr863_productionorder1id: 'ord-guid',
    cr863_orderid: '515298',
    cr863_order: '20285-EHF-KS',
    cr863_item: 'Shuttle Beam : M100',
    cr863_itemid: 'SH.BDC.',
    cr863_workcenter: '7',
    cr863_req_q: 78,
    cr863_finished_q: 78,
    cr863_rem_q: 0,
    cr863_dwg1: ',SH028',
    cr863_dwg2: '0',
    cr863_cusname: 'Seara',
    cr863_color: 'YW1204L',
    cr863_explocal: 'Export-KS',
    cr863_accessstatus: 'Cancel',
    cr863_year: 2026,
    cr863_pivot: '01/2028',
    cr863_rawmaterialdescription: 'RM.ST.CO.PRG. : 298 : 2.4 : S420GD+Z275MAC : ZCL',
    cr863_releasedate: '2026-02-01T00:00:00Z',
  }

  it('keeps the Dataverse GUID as the document id, making a re-run idempotent', () => {
    const { id, doc } = transformOrder(row, ctx())
    expect(id).toBe('ord-guid')
    expect(doc.legacyId).toBe('ord-guid')
  })

  it('displays the human order number and keeps the numeric key alongside it', () => {
    const { doc } = transformOrder(row, ctx())
    expect(doc.orderNumber).toBe('20285-EHF-KS')
    expect(doc.legacyOrderId).toBe('515298')
  })

  it('carries the real order status, so cancelled orders are not shown as live work', () => {
    const { doc } = transformOrder(row, ctx())
    expect(doc.status).toBe('Cancel')
  })

  it('keeps planning fields rather than discarding them', () => {
    const { doc } = transformOrder(row, ctx())
    expect(doc.legacy.year).toBe(2026)
    expect(doc.legacy.pivot).toBe('01/2028')
  })

  it('falls back to the numeric key when there is no human order number', () => {
    const { doc } = transformOrder({ ...row, cr863_order: null }, ctx())
    expect(doc.orderNumber).toBe('515298')
  })
})

describe('machines', () => {
  it('reads the inverted columns the right way round', () => {
    const { doc } = transformMachine({
      cr863_machinesid: 'm1',
      cr863_workcenter: '58',
      cr863_machinename: 'LM4',
      cr863_factory: 'A. Welding Line',
    })
    expect(doc.code).toBe('58')
    expect(doc.name).toBe('A. Welding Line')
    expect(doc.line).toBe('LM4')
  })

  it('reproduces the label the old app showed', () => {
    expect(
      transformMachine({
        cr863_machinesid: 'm1',
        cr863_workcenter: '58',
        cr863_machinename: 'LM4',
        cr863_factory: 'A. Welding Line',
      }).doc.displayName,
    ).toBe('58-A. Welding Line-LM4')
    expect(
      transformMachine({
        cr863_machinesid: 'm2',
        cr863_workcenter: '1',
        cr863_machinename: 'LM1',
        cr863_factory: 'Shearing',
      }).doc.displayName,
    ).toBe('1-Shearing-LM1')
  })
})

describe('sessions and samples', () => {
  const c = () =>
    ctx({
      orderWorkCenter: new Map([['ord-1', '58']]),
      sessionInspector: new Map([['sess-1', 'Mohamed Abdelrahman']]),
      sessionInit: new Map([
        ['sess-1', { quality_isconfirmed: true, quality_initializedon: '2026-06-10T12:32:44Z', quality_sessioninitializationid: 'init-1' }],
      ]),
    })

  const sessionRow = {
    cr863_inspectionsession1id: 'sess-1',
    _cr863_productionorder_value: 'ord-1',
    cr863_sessionnumber: 2,
    cr863_qty: 1398,
    cr863_sessionstatus: 898710003,
    cr863_sessiondatetime: '2026-07-20T09:01:00Z',
    _createdby_value: 'user-guid',
  }

  it('takes the work centre from the order, since the session has none', () => {
    expect(transformSession(sessionRow, c()).doc.workCenterCode).toBe('58')
  })

  it('confirms the starting quantity from the session, not the initialisation row', () => {
    // quality_qty is 0 in 62 of 71 initialisation rows, so it cannot be the source.
    const { doc } = transformSession(sessionRow, c())
    expect(doc.startQtyConfirmed.qty).toBe(1398)
    expect(doc.startQtyConfirmed.at).toBe('2026-06-10T12:32:44Z')
    expect(doc.legacy.initialisationConfirmed).toBe(true)
  })

  it('keeps the per-order session counter', () => {
    expect(transformSession(sessionRow, c()).doc.seq).toBe(2)
  })

  it('rejects a session with no order rather than importing an orphan', () => {
    const r = transformSession({ ...sessionRow, _cr863_productionorder_value: null }, c())
    expect(r.reject.reason).toMatch(/no production order/)
  })

  it('uses the recorded shift as-is instead of re-deriving it', () => {
    // 21:40 would derive as night, but the record says Morning — the record wins.
    const { doc } = transformSample(
      {
        cr863_inspectionsample1id: 'smp-1',
        _cr863_inspectionsession_value: 'sess-1',
        cr863_shift: 898710000,
        cr863_sampledatetime: '2026-07-20T21:40:00Z',
        cr863_samplequantity: 6,
        cr863_inspectorname: 'QC2',
      },
      ctx({ session: new Map([['sess-1', { orderId: 'ord-1', drawing: 'BS9174' }]]) }),
    )
    expect(doc.shift).toBe('A')
    expect(doc.orderId).toBe('ord-1')
    expect(doc.drawing).toBe('BS9174')
  })

  it('derives a submission id from the source guid so a re-run cannot duplicate', () => {
    const { doc } = transformSample(
      { cr863_inspectionsample1id: 'smp-1', _cr863_inspectionsession_value: 'sess-1' },
      ctx(),
    )
    expect(doc.submissionId).toBe('legacy:smp-1')
  })
})

describe('results', () => {
  it('maps a measurement without losing precision', () => {
    const { doc } = transformDimensionResult(
      {
        cr863_dimensionresult2id: 'd1',
        _cr863_inspectionsample_value: 'smp-1',
        cr863_dimensionname: 'L : 4800',
        cr863_nominal: 4800,
        cr863_actual: 4799.5,
        cr863_toleranceplus: 2,
        cr863_toleranceminus: 2,
        cr863_status: 898710000,
      },
      ctx(),
    )
    expect(doc.actual).toBe(4799.5)
    expect(doc.nominal).toBe(4800)
    expect(doc.status).toBe('Pass')
  })

  it('treats an unevaluated measurement as Pending, never as Pass', () => {
    const { doc } = transformDimensionResult(
      {
        cr863_dimensionresult2id: 'd2',
        _cr863_inspectionsample_value: 'smp-1',
        cr863_dimensionname: 'Paint Thickness',
        cr863_actual: 88,
        cr863_status: null,
      },
      ctx(),
    )
    expect(doc.status).toBe('Pending')
    // Recorded explicitly as "there was no nominal", not merely absent.
    expect(doc.nominal).toBeNull()
  })

  it('maps a defect and its disposition', () => {
    const { doc } = transformDefectResult(
      {
        cr863_visualdefectresult2id: 'v1',
        _cr863_inspectionsample_value: 'smp-1',
        cr863_defectname: 'ترحيل فى الابعاد',
        cr863_defectquantity: 9,
        cr863_defectstatus: 898710001,
      },
      ctx(),
    )
    expect(doc.defectName).toBe('ترحيل فى الابعاد')
    expect(doc.disposition).toBe('Hold')
    expect(doc.imageIds).toEqual([])
  })
})

describe('audit log', () => {
  it('maps an update with its old and new values', () => {
    const { doc } = transformAuditLog(
      {
        cr863_auditlogid: 'a1',
        cr863_actiontype: 898710000,
        cr863_entity: 'InspectionSample',
        cr863_fieldname: 'samplequantity',
        cr863_oldvalue: '32',
        cr863_newvalue: '77',
        cr863_recordid: 'rec-1',
        cr863_username: 'QC2',
        cr863_timestamp: '2026-07-01T08:00:00Z',
      },
      ctx(),
    )
    expect(doc.action).toBe('update')
    expect(doc.oldValue).toBe('32')
    expect(doc.newValue).toBe('77')
  })

  it('records a creation as an update, because upstream has no Create action', () => {
    const { doc } = transformAuditLog(
      {
        cr863_auditlogid: 'a2',
        cr863_actiontype: 898710000,
        cr863_entity: 'SampleCoil',
        cr863_fieldname: 'New Coil',
        cr863_newvalue: '5555',
        cr863_recordid: 'new',
      },
      ctx(),
    )
    expect(doc.action).toBe('update')
  })

  it('rejects an entry whose action cannot be decoded rather than assuming one', () => {
    const c = ctx()
    const r = transformAuditLog({ cr863_auditlogid: 'a3', cr863_actiontype: 898710077 }, c)
    expect(r.reject).toBeTruthy()
    expect(c.failures).toHaveLength(1)
  })
})

describe('identity and grade pairs', () => {
  it('namespaces legacy users so they cannot collide with Firebase uids', () => {
    expect(legacyUid('abc')).toBe('legacy:abc')
    expect(legacyUid(null)).toBe('legacy:unknown')
  })

  it('maps a grade pair and rejects a half-empty one', () => {
    expect(
      transformGradeMapping({ quality_grademappingid: 'g1', quality_grade: 'N09C', quality_equivalentgrade: 'S355J2' })
        .doc,
    ).toMatchObject({ gradeA: 'N09C', gradeB: 'S355J2' })
    expect(
      transformGradeMapping({ quality_grademappingid: 'g2', quality_grade: 'N09C' }).reject.reason,
    ).toMatch(/missing one side/)
  })
})

// ---------------------------------------------------------------------------
// The streaming reader is hand-rolled so the tool needs no dependencies, which
// makes it the riskiest part of the script. An earlier version re-scanned
// characters after a chunk boundary, double-counting braces and corrupting the
// depth — these cover exactly that.
// ---------------------------------------------------------------------------
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamRows } from './qc-dryrun.mjs'

function fixtureFile(rows, { pretty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qcstream-'))
  const p = join(dir, 'rows.json')
  const payload = { table: 't', rowCount: rows.length, rows }
  writeFileSync(p, pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload))
  return p
}

async function collect(p) {
  const out = []
  for await (const r of streamRows(p)) out.push(r)
  return out
}

describe('streaming reader', () => {
  it('reads every row of a small file', async () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }]
    expect(await collect(fixtureFile(rows))).toEqual(rows)
  })

  it('handles an empty rows array', async () => {
    expect(await collect(fixtureFile([]))).toEqual([])
  })

  it('handles pretty-printed files with newlines between elements', async () => {
    const rows = [{ a: 1 }, { a: 2 }]
    expect(await collect(fixtureFile(rows, { pretty: true }))).toEqual(rows)
  })

  it('keeps braces, brackets and escaped quotes that live inside strings', async () => {
    const rows = [
      { s: 'a {brace} and [bracket]' },
      { s: 'he said "hello"' },
      { s: 'trailing backslash \\' },
      { s: '}{][' },
    ]
    expect(await collect(fixtureFile(rows))).toEqual(rows)
  })

  it('preserves Arabic text and newlines', async () => {
    const rows = [{ s: 'ترحيل فى الابعاد', t: 'line1\nline2' }]
    expect(await collect(fixtureFile(rows))).toEqual(rows)
  })

  it('reads nested objects and arrays without ending an element early', async () => {
    const rows = [{ a: { b: { c: [1, 2, { d: 3 }] } } }, { a: 2 }]
    expect(await collect(fixtureFile(rows))).toEqual(rows)
  })

  it('reads a file far larger than one chunk without losing or duplicating rows', async () => {
    // 20k rows padded past the 1 MiB read size, so elements are split across
    // chunk boundaries many times over.
    const rows = Array.from({ length: 20000 }, (_, i) => ({
      id: `ord-${i}`,
      pad: 'x'.repeat(120),
      s: 'quote " brace { bracket [ arabic ترحيل',
    }))
    const got = await collect(fixtureFile(rows))
    expect(got).toHaveLength(20000)
    expect(got[0].id).toBe('ord-0')
    expect(got[19999].id).toBe('ord-19999')
    expect(new Set(got.map((r) => r.id)).size).toBe(20000)
    expect(got.every((r) => r.s.includes('ترحيل'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Quarantine. The old save wrote dimension rows before linking them to their
// sample, so a mid-save failure left rows stranded. Rows carrying a real
// reading are evidence and must survive the migration for a person to place.
// ---------------------------------------------------------------------------
import { transformDimensionResult as td, transformSample as ts, COL as COLS } from './qc-dryrun.mjs'

describe('rows with no parent', () => {
  it('quarantines a stranded measurement instead of dropping it', () => {
    const c = ctx()
    const out = td(
      {
        cr863_dimensionresult2id: 'd-value',
        _cr863_inspectionsample_value: null,
        cr863_dimensionname: 'Paint Thickness',
        cr863_actual: 89.4,
      },
      c,
    )
    expect(out.collection).toBe(COLS.orphanMeasurements)
    expect(out.doc.actual).toBe(89.4)
    expect(out.doc.quarantined).toBe(true)
    expect(out.doc.needsReview).toBe(true)
    expect(out.doc.legacyId).toBe('d-value')
    expect(c.counts.parentlessDimensionWithValue).toBe(1)
  })

  it('keeps the judgement that was recorded against a stranded reading', () => {
    const out = td(
      {
        cr863_dimensionresult2id: 'd-fail',
        _cr863_inspectionsample_value: null,
        cr863_dimensionname: 'K',
        cr863_nominal: 100,
        cr863_actual: 100.6,
        cr863_status: 898710001,
      },
      ctx(),
    )
    expect(out.doc.status).toBe('Fail')
    expect(out.doc.nominal).toBe(100)
  })

  it('drops an unfilled template row but counts it', () => {
    const c = ctx()
    const out = td(
      { cr863_dimensionresult2id: 'd-empty', _cr863_inspectionsample_value: null, cr863_actual: null },
      c,
    )
    expect(out.reject).toBeTruthy()
    expect(out.reject.reason).toMatch(/unfilled template row/)
    expect(c.counts.parentlessDimensionEmpty).toBe(1)
    expect(c.counts.parentlessDimensionWithValue).toBeUndefined()
  })

  it('quarantines a sample with no session rather than deleting it', () => {
    const c = ctx()
    const out = ts(
      {
        cr863_inspectionsample1id: 'smp-noses',
        _cr863_inspectionsession_value: null,
        cr863_samplename: 'SMP-Drive In Rear Bracing Channel',
        cr863_shift: 898710000,
        cr863_samplequantity: 2,
      },
      c,
    )
    expect(out.collection).toBe(COLS.orphanSamples)
    expect(out.doc.quarantined).toBe(true)
    expect(out.doc.legacy.sampleName).toContain('Drive In Rear Bracing')
    expect(c.counts.parentlessSample).toBe(1)
  })
})

describe('route placeholder', () => {
  it('leaves the "0" placeholder unset and reports it rather than guessing', () => {
    const r = decodeRoute('0')
    expect(r.value).toBeUndefined()
    expect(r.failure.reason).toMatch(/placeholder/)
  })
})
