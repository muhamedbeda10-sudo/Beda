#!/usr/bin/env node
// ============================================================================
// Dataverse -> QC System : migration DRY RUN
//
//   node qc-dryrun.mjs /path/to/qc-migration/data
//
// Self-contained. Node 22 built-ins only (fs, path) — no npm install, no
// firebase-admin, no network. It reads the exported tables, applies the full
// transform, and prints a reconciliation report. It NEVER writes anything.
//
// The 46 MB export is read as a stream: the file is never held in memory whole.
// ============================================================================

import { createReadStream } from 'node:fs'
import { statSync } from 'node:fs'
import path from 'node:path'

// ============================================================================
// 1. Streaming JSON reader
// ============================================================================

/**
 * Yield each object inside the top-level `rows` array of a
 * `{"table":..,"rowCount":N,"rows":[...]}` file.
 *
 * Written by hand so the tool has no dependencies. It scans for the `rows`
 * array, then walks characters tracking string state and brace depth; each
 * time depth returns to zero one complete element has been seen and is parsed
 * on its own. Consumed text is dropped from the buffer as it goes, so peak
 * memory is one chunk plus one row, not the file.
 */
export async function* streamRows(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 })

  let buf = ''
  let pos = 0 // next character to examine, persists across chunks
  let started = false // have we found `"rows" : [` yet?
  let elemStart = -1 // where the element being read began, -1 between elements
  let depth = 0
  let inString = false
  let escaped = false
  let done = false

  for await (const chunk of stream) {
    buf += chunk

    if (!started) {
      const m = /"rows"\s*:\s*\[/.exec(buf)
      if (!m) {
        // Keep a tail in case the key straddles a chunk boundary.
        if (buf.length > 4096) buf = buf.slice(-4096)
        continue
      }
      buf = buf.slice(m.index + m[0].length)
      pos = 0
      started = true
    }

    while (pos < buf.length) {
      const c = buf[pos]

      if (elemStart === -1) {
        // Between elements: skip whitespace and commas, stop at the closing ].
        if (c === ']') {
          done = true
          break
        }
        if (c === '{') {
          elemStart = pos
          depth = 1
          inString = false
          escaped = false
        }
        pos++
        continue
      }

      // Inside an element. The opening brace was consumed above, so every
      // character is seen exactly once even when a chunk splits an element.
      if (inString) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') inString = false
      } else if (c === '"') {
        inString = true
      } else if (c === '{') {
        depth++
      } else if (c === '}') {
        depth--
        if (depth === 0) {
          const text = buf.slice(elemStart, pos + 1)
          elemStart = -1
          pos++
          yield JSON.parse(text)
          continue
        }
      }
      pos++
    }

    if (done) break

    // Drop what has been consumed so the buffer cannot grow with the file,
    // keeping the partial element when one is in progress.
    const keepFrom = elemStart === -1 ? pos : elemStart
    if (keepFrom > 0) {
      buf = buf.slice(keepFrom)
      pos -= keepFrom
      if (elemStart !== -1) elemStart = 0
    }
  }
  stream.destroy()
}

// ============================================================================
// 2. Choice decoding — from the Dataverse metadata, never inferred
// ============================================================================

// The numbering is NOT consistent between columns: session status starts at
// ...002 while everything else starts at ...000. 898710002 means Open for a
// session, Night for a shift and Warning for a dimension.
export const SESSION_STATUS = { 898710002: 'Open', 898710003: 'Closed' }
export const SHIFT = { 898710000: 'A', 898710001: 'B', 898710002: 'C' }
export const DIMENSION_STATUS = { 898710000: 'Pass', 898710001: 'Fail', 898710002: 'Warning' }
export const DEFECT_STATUS = {
  898710000: 'Rejected',
  898710001: 'Hold',
  898710002: 'Repair',
  898710003: 'Used in another order',
  898710004: 'Accept with concession',
}
/** Only two values exist upstream. Creation was logged as Update (e.g. "New
 *  Coil" with a null old value), so no Create is ever synthesised. */
export const AUDIT_ACTION = { 898710000: 'update', 898710001: 'delete' }

/** Order status really lives in cr863_accessstatus; cr863_status is empty in
 *  all 28,871 rows. Losing this would hide that 7,232 orders are cancelled. */
export const ORDER_STATUS = new Set(['Active', 'Cancel', 'Hold', 'Stock'])

const ROUTES = { local: 'Local', export: 'Export', 'export-ks': 'Export-KS' }

export function decodeChoice(table, field, raw, fallback = null) {
  if (raw === null || raw === undefined || raw === '') return { value: fallback }
  const hit = table[Number(raw)]
  if (hit === undefined) {
    return { failure: { field, value: raw, reason: 'not present in the Dataverse choice metadata' } }
  }
  return { value: hit }
}

export function decodeRoute(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null }
  const hit = ROUTES[String(raw).trim().toLowerCase()]
  return hit ? { value: hit } : { failure: { field: 'cr863_explocal', value: raw, reason: 'unrecognised route' } }
}

export function decodeOrderStatus(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null }
  const v = String(raw).trim()
  return ORDER_STATUS.has(v)
    ? { value: v }
    : { failure: { field: 'cr863_accessstatus', value: raw, reason: 'unrecognised order status' } }
}

/**
 * Pull the steel grade out of the raw-material description:
 *   "RM.ST.CO.PRG. : 298 : 2.4 : S420GD+Z275MAC : ZCL" -> "S420GD+Z275MAC"
 * Only the five-segment form is trusted. 65% of orders carry no description at
 * all; those keep a null grade and the mismatch check must skip rather than
 * compare against an invention.
 */
export function extractGrade(desc) {
  if (!desc) return null
  const parts = String(desc).split(':').map((p) => p.trim())
  if (parts.length !== 5) return null
  return parts[3] && parts[3] !== '0' ? parts[3] : null
}

export const isoOrNull = (r) => (r && !Number.isNaN(new Date(String(r)).getTime()) ? String(r) : null)
export const numOrNull = (r) =>
  r === null || r === undefined || r === '' || !Number.isFinite(Number(r)) ? null : Number(r)
export const strOrNull = (r) => {
  if (r === null || r === undefined) return null
  const s = String(r).trim()
  return s === '' ? null : s
}
/** Legacy users are Dataverse GUIDs, not Firebase uids — namespaced so the two
 *  identity spaces can never collide. */
export const legacyUid = (g) => (g ? `legacy:${g}` : 'legacy:unknown')

// ============================================================================
// 3. Row -> document
// ============================================================================

export const COL = {
  orders: 'orders',
  machines: 'machines',
  coils: 'coils',
  sessions: 'sessions',
  samples: 'samples',
  dimensions: 'dimensions',
  defects: 'defects',
  sampleCoils: 'sampleCoils',
  pdi: 'pdiDocuments',
  itemDimensionOrder: 'itemDimensionOrder',
  itemDimensionMaster: 'itemDimensionMaster',
  itemReferenceImages: 'itemReferenceImages',
  workCenterDefects: 'workCenterDefects',
  workCenterDimensions: 'workCenterDimensions',
  gradeMappings: 'gradeMappings',
  audit: 'auditLogs',
  productionData: 'productionData',
}

const reject = (reason, extra = {}) => ({ reject: { reason, ...extra } })

/** Firestore rejects undefined; drop those keys rather than writing nulls that
 *  would read as a deliberately cleared value. */
export function pruned(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    out[k] = v
  }
  return out
}

export function transformOrder(r, ctx) {
  const id = r.cr863_productionorder1id
  if (!id) return reject('missing primary key')

  const route = decodeRoute(r.cr863_explocal)
  if (route.failure) ctx.decodeFailure(route.failure, id)
  const status = decodeOrderStatus(r.cr863_accessstatus)
  if (status.failure) ctx.decodeFailure(status.failure, id)

  const grade = extractGrade(r.cr863_rawmaterialdescription)
  ctx.count(grade ? 'gradeExtracted' : 'gradeUnavailable')
  if (status.value) ctx.count(`status:${status.value}`)

  return {
    collection: COL.orders,
    id,
    doc: pruned({
      id,
      legacyId: id,
      legacyOrderId: strOrNull(r.cr863_orderid),
      orderNumber: strOrNull(r.cr863_order) ?? strOrNull(r.cr863_orderid) ?? id,
      item: strOrNull(r.cr863_item) ?? '',
      itemCode: strOrNull(r.cr863_itemid) ?? '',
      workCenterCode: strOrNull(r.cr863_workcenter) ?? '',
      requiredQty: numOrNull(r.cr863_req_q) ?? 0,
      finishedQty: numOrNull(r.cr863_finished_q) ?? 0,
      drawing: strOrNull(r.cr863_dwg1) ?? '',
      drawingAlt: strOrNull(r.cr863_dwg2) ?? undefined,
      material: strOrNull(r.cr863_rawmaterialdescription) ?? '',
      expectedGrade: grade ?? '',
      customer: strOrNull(r.cr863_cusname) ?? '',
      colour: strOrNull(r.cr863_color) ?? '',
      type: route.value ?? '',
      status: status.value ?? undefined,
      date: isoOrNull(r.cr863_releasedate) ?? isoOrNull(r.createdon) ?? '',
      // Planning data with no home in the model — kept, not discarded.
      legacy: pruned({
        year: numOrNull(r.cr863_year),
        pivot: strOrNull(r.cr863_pivot),
        remQty: numOrNull(r.cr863_rem_q),
        weightKg: numOrNull(r.cr863_wkg),
        lengthMm: numOrNull(r.cr863_lmm),
        widthMm: numOrNull(r.cr863_wmm),
        thickness: numOrNull(r.cr863_t),
        rawMaterialPowder: strOrNull(r.cr863_rawmaterialpowder),
        createdOn: isoOrNull(r.createdon),
        createdBy: strOrNull(r._createdby_value),
      }),
    }),
  }
}

export function transformMachine(r) {
  const id = r.cr863_machinesid
  if (!id) return reject('missing primary key')
  // The columns are inverted relative to their names: machinename holds the
  // line (LM1..LM4), factory holds the work-centre process name. The old app
  // laboured this into "{workcenter}-{factory}-{machinename}".
  const code = strOrNull(r.cr863_workcenter) ?? ''
  const name = strOrNull(r.cr863_factory) ?? ''
  const line = strOrNull(r.cr863_machinename) ?? ''
  return {
    collection: COL.machines,
    id,
    doc: { id, legacyId: id, code, name, line, displayName: [code, name, line].filter(Boolean).join('-') },
  }
}

export function transformCoil(r) {
  const id = r.cr863_samplecoilcopyid
  if (!id) return reject('missing primary key')
  const coilNumber = strOrNull(r.cr863_coilnumber)
  if (!coilNumber) return reject('coil has no coil number', { id })
  return {
    collection: COL.coils,
    id,
    doc: pruned({
      id,
      legacyId: id,
      coilNumber,
      grade: strOrNull(r.cr863_grade),
      smType: strOrNull(r.cr863_smtype),
      supplier: strOrNull(r.cr863_supplier),
      thickness: numOrNull(r.cr863_t),
      width: numOrNull(r.cr863_w),
      yield: numOrNull(r.cr863_yield),
    }),
  }
}

export function transformDimensionOrder(r) {
  const id = r.quality_dimensionorderid
  if (!id) return reject('missing primary key')
  return {
    collection: COL.itemDimensionOrder,
    id,
    doc: pruned({
      id,
      legacyId: id,
      item: strOrNull(r.quality_item) ?? '',
      dimensionName: strOrNull(r.quality_dimensionname) ?? '',
      sequence: numOrNull(r.quality_sequencenumber) ?? 0,
      // The source carries tolerances only — nominal is decided per order.
      tolPlus: numOrNull(r.quality_toleranceplus) ?? 0,
      tolMinus: numOrNull(r.quality_toleranceminus) ?? 0,
      unit: '',
    }),
  }
}

export function transformDimensionMaster(r) {
  const id = r.cr863_dimensionid
  if (!id) return reject('missing primary key')
  return {
    collection: COL.itemDimensionMaster,
    id,
    doc: pruned({
      id,
      legacyId: id,
      item: strOrNull(r.cr863_itemid) ?? '',
      dimensionName: strOrNull(r.cr863_dimensionname) ?? '',
      tolPlus: numOrNull(r.cr863_toleranceplus) ?? 0,
      tolMinus: numOrNull(r.cr863_toleranceminus) ?? 0,
      unit: '',
    }),
  }
}

export function transformWorkCenterDefect(r) {
  const id = r.cr863_workcentervisualdefectid
  if (!id) return reject('missing primary key')
  return {
    collection: COL.workCenterDefects,
    id,
    doc: {
      id,
      legacyId: id,
      workCenterCode: strOrNull(r.cr863_workcenter) ?? '',
      defectName: strOrNull(r.cr863_defectname) ?? '',
    },
  }
}

export function transformWorkCenterDimension(r) {
  const id = r.cr863_workcenterdimensionid
  if (!id) return reject('missing primary key')
  return {
    collection: COL.workCenterDimensions,
    id,
    doc: {
      id,
      legacyId: id,
      workCenterCode: strOrNull(r.cr863_workcenter) ?? '',
      dimensionName: strOrNull(r.cr863_dimensionname) ?? '',
    },
  }
}

export function transformGradeMapping(r) {
  const id = r.quality_grademappingid
  if (!id) return reject('missing primary key')
  const a = strOrNull(r.quality_grade)
  const b = strOrNull(r.quality_equivalentgrade)
  if (!a || !b) return reject('grade mapping is missing one side of the pair', { id })
  return {
    collection: COL.gradeMappings,
    id,
    doc: pruned({ id, legacyId: id, gradeA: a, gradeB: b, notes: strOrNull(r.quality_notes) }),
  }
}

export function transformItemImage(r) {
  const id = r.quality_itemimageid
  if (!id) return reject('missing primary key')
  return {
    collection: COL.itemReferenceImages,
    id,
    doc: pruned({
      id,
      legacyId: id,
      item: strOrNull(r.quality_itemid) ?? '',
      // Images are a separate pass; the row keeps its source URL until the file
      // is uploaded and a real imageId replaces it.
      imageId: '',
      legacyImageUrl: strOrNull(r.quality_imagelink),
      imagePending: true,
    }),
  }
}

export function transformProductionData(r) {
  const id = r.cr863_productiondataid
  if (!id) return reject('missing primary key')
  // Production output, not QC. Archived verbatim rather than discarded.
  const doc = { id, legacyId: id }
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('cr863_') && v !== null && v !== undefined) doc[k.slice(6)] = v
  }
  return { collection: COL.productionData, id, doc }
}

export function transformSession(r, ctx) {
  const id = r.cr863_inspectionsession1id
  if (!id) return reject('missing primary key')
  const orderId = strOrNull(r._cr863_productionorder_value)
  if (!orderId) return reject('session has no production order', { id })

  const status = decodeChoice(SESSION_STATUS, 'cr863_sessionstatus', r.cr863_sessionstatus, 'Open')
  if (status.failure) ctx.decodeFailure(status.failure, id)

  const startedAt = isoOrNull(r.cr863_sessiondatetime) ?? isoOrNull(r.createdon) ?? ''
  const qty = numOrNull(r.cr863_qty)
  // Initialisation rows link by quality_sessionkey, held as text rather than as
  // a lookup. quality_qty is 0 in 62 of 71, so the quantity comes from the
  // session itself.
  const init = ctx.sessionInit?.get(id)

  return {
    collection: COL.sessions,
    id,
    doc: pruned({
      id,
      legacyId: id,
      seq: numOrNull(r.cr863_sessionnumber) ?? 1,
      orderId,
      // Sessions carry no work centre; it comes from the order.
      workCenterCode: ctx.orderWorkCenter?.get(orderId) ?? '',
      inspectorUid: legacyUid(r._createdby_value),
      inspectorName: ctx.sessionInspector?.get(id) ?? '',
      startedAt,
      status: status.value ?? 'Open',
      startQtyConfirmed:
        qty === null
          ? undefined
          : {
              qty,
              byUid: legacyUid(r._createdby_value),
              byName: ctx.sessionInspector?.get(id) ?? '',
              at: isoOrNull(init?.quality_initializedon) ?? startedAt,
            },
      closedAt: status.value === 'Closed' ? isoOrNull(r.modifiedon) : undefined,
      version: 0,
      legacy: pruned({
        sessionName: strOrNull(r.cr863_sessionname),
        drawingNo: strOrNull(r.cr863_drawingno),
        issueNo: strOrNull(r.cr863_issueno),
        notes: strOrNull(r.cr863_notes),
        createdOn: isoOrNull(r.createdon),
        createdBy: strOrNull(r._createdby_value),
        initialisationConfirmed: init ? init.quality_isconfirmed === true : undefined,
        initialisationId: init ? init.quality_sessioninitializationid : undefined,
      }),
    }),
  }
}

export function transformSample(r, ctx) {
  const id = r.cr863_inspectionsample1id
  if (!id) return reject('missing primary key')
  const sessionId = strOrNull(r._cr863_inspectionsession_value)
  if (!sessionId) return reject('sample has no session', { id })

  // The stored shift is the historical record and is used as-is; re-deriving it
  // from the timestamp would silently rewrite what the inspector recorded.
  const shift = decodeChoice(SHIFT, 'cr863_shift', r.cr863_shift, null)
  if (shift.failure) ctx.decodeFailure(shift.failure, id)

  const session = ctx.session?.get(sessionId)
  return {
    collection: COL.samples,
    id,
    doc: pruned({
      id,
      legacyId: id,
      sessionId,
      orderId: session?.orderId ?? '',
      index: ctx.sampleIndex?.get(id) ?? 1,
      shift: shift.value ?? undefined,
      createdAt: isoOrNull(r.cr863_sampledatetime) ?? isoOrNull(r.createdon) ?? '',
      inspectorUid: legacyUid(r._createdby_value),
      inspectorName: strOrNull(r.cr863_inspectorname) ?? '',
      drawing: session?.drawing ?? '',
      issue: session?.issue ?? undefined,
      sampleQty: numOrNull(r.cr863_samplequantity) ?? 0,
      // Derived from the source guid, so a re-run cannot duplicate a sample.
      submissionId: `legacy:${id}`,
      version: 0,
      legacy: pruned({
        sampleName: strOrNull(r.cr863_samplename),
        createdOn: isoOrNull(r.createdon),
        createdBy: strOrNull(r._createdby_value),
      }),
    }),
  }
}

export function transformDimensionResult(r, ctx) {
  const id = r.cr863_dimensionresult2id
  if (!id) return reject('missing primary key')
  const sampleId = strOrNull(r._cr863_inspectionsample_value)
  if (!sampleId) return reject('dimension result has no sample', { id })

  // A null status is "not evaluated", never a pass.
  const status = decodeChoice(DIMENSION_STATUS, 'cr863_status', r.cr863_status, 'Pending')
  if (status.failure) ctx.decodeFailure(status.failure, id)

  const nominal = numOrNull(r.cr863_nominal)
  const actual = numOrNull(r.cr863_actual)
  if (actual !== null && nominal === null) ctx.count('measurementWithoutSpecification')

  return {
    collection: COL.dimensions,
    id,
    doc: pruned({
      id,
      legacyId: id,
      sampleId,
      name: strOrNull(r.cr863_dimensionname) ?? '',
      sequence: ctx.dimensionSequence?.get(id) ?? 0,
      nominal,
      tolPlus: numOrNull(r.cr863_toleranceplus),
      tolMinus: numOrNull(r.cr863_toleranceminus),
      actual,
      unit: '',
      status: status.value ?? 'Pending',
      source: 'legacy',
    }),
  }
}

export function transformDefectResult(r, ctx) {
  const id = r.cr863_visualdefectresult2id
  if (!id) return reject('missing primary key')
  const sampleId = strOrNull(r._cr863_inspectionsample_value)
  if (!sampleId) return reject('defect result has no sample', { id })

  const disp = decodeChoice(DEFECT_STATUS, 'cr863_defectstatus', r.cr863_defectstatus, null)
  if (disp.failure) ctx.decodeFailure(disp.failure, id)
  if (disp.value) ctx.count(`disposition:${disp.value}`)

  return {
    collection: COL.defects,
    id,
    doc: pruned({
      id,
      legacyId: id,
      sampleId,
      defectName: strOrNull(r.cr863_defectname) ?? '',
      qty: numOrNull(r.cr863_defectquantity) ?? 0,
      disposition: disp.value,
      notes: strOrNull(r.cr863_notes),
      imageIds: [],
      legacyImageUrl: strOrNull(r.cr863_image),
    }),
  }
}

export function transformSampleCoil(r) {
  const id = r.cr863_samplecoil2id
  if (!id) return reject('missing primary key')
  const sampleId = strOrNull(r._cr863_inspectionsample_value)
  if (!sampleId) return reject('sample coil has no sample', { id })
  return {
    collection: COL.sampleCoils,
    id,
    doc: pruned({
      id,
      legacyId: id,
      sampleId,
      coilNumber: strOrNull(r.cr863_coilnumber) ?? '',
      grade: strOrNull(r.cr863_grade),
      smType: strOrNull(r.cr863_smtype),
      supplier: strOrNull(r.cr863_supplier),
      thickness: numOrNull(r.cr863_t),
      width: numOrNull(r.cr863_w),
      yield: numOrNull(r.cr863_yield),
      notes: strOrNull(r.cr863_notes),
    }),
  }
}

export function transformPdi(r) {
  const id = r.cr863_pdiid
  if (!id) return reject('missing primary key')
  return {
    collection: COL.pdi,
    id,
    doc: pruned({
      id,
      legacyId: id,
      orderId: strOrNull(r._cr863_productionorder_value) ?? '',
      notes: strOrNull(r.cr863_notes),
      imageIds: [],
      createdAt: isoOrNull(r.cr863_createddate) ?? isoOrNull(r.createdon) ?? '',
      createdByUid: legacyUid(r._createdby_value),
      legacy: pruned({ item: strOrNull(r.cr863_item), createdByName: strOrNull(r.cr863_createdby) }),
    }),
  }
}

export function transformAuditLog(r, ctx) {
  const id = r.cr863_auditlogid
  if (!id) return reject('missing primary key')
  const action = decodeChoice(AUDIT_ACTION, 'cr863_actiontype', r.cr863_actiontype, null)
  if (action.failure) ctx.decodeFailure(action.failure, id)
  if (!action.value) return reject('audit entry has no decodable action', { id })

  return {
    collection: COL.audit,
    id,
    doc: pruned({
      id,
      legacyId: id,
      at: isoOrNull(r.cr863_timestamp) ?? isoOrNull(r.createdon) ?? '',
      userUid: legacyUid(r._createdby_value),
      userName: strOrNull(r.cr863_username) ?? '',
      action: action.value,
      entity: strOrNull(r.cr863_entity) ?? '',
      entityId: strOrNull(r.cr863_recordid) ?? '',
      field: strOrNull(r.cr863_fieldname),
      oldValue: strOrNull(r.cr863_oldvalue),
      newValue: strOrNull(r.cr863_newvalue),
      orderNumber: strOrNull(r.cr863_order),
      item: strOrNull(r.cr863_item),
      sessionId: strOrNull(r.cr863_session),
      sampleId: strOrNull(r.cr863_sample),
      legacy: pruned({ machine: strOrNull(r.cr863_machine) }),
    }),
  }
}

// ============================================================================
// 4. Files, in dependency order
// ============================================================================

export const FILES = [
  { file: '12_cr863_productionorder1s.json', expect: 28871, fn: transformOrder, label: 'production orders' },
  { file: '13_cr863_samplecoilcopies.json', expect: 30296, fn: transformCoil, label: 'coil catalogue' },
  { file: '15_cr863_dimensions.json', expect: 24, fn: transformDimensionMaster, label: 'dimension master' },
  { file: '16_quality_dimensionorders.json', expect: 328, fn: transformDimensionOrder, label: 'dimension order' },
  { file: '17_cr863_workcenterdimensions.json', expect: 1, fn: transformWorkCenterDimension, label: 'work-centre dims' },
  { file: '18_cr863_workcentervisualdefects.json', expect: 52, fn: transformWorkCenterDefect, label: 'work-centre defects' },
  { file: '19_quality_grademappings.json', expect: 7, fn: transformGradeMapping, label: 'grade mappings' },
  { file: '20_cr863_machineses.json', expect: 32, fn: transformMachine, label: 'machines' },
  { file: '21_quality_itemimages.json', expect: 42, fn: transformItemImage, label: 'item reference images' },
  { file: '23_cr863_productiondatas.json', expect: 11, fn: transformProductionData, label: 'production data' },
  { file: '01_cr863_inspectionsession1s.json', expect: 147, fn: transformSession, label: 'inspection sessions' },
  { file: '02_cr863_inspectionsample1s.json', expect: 374, fn: transformSample, label: 'inspection samples' },
  { file: '03_cr863_dimensionresult2s.json', expect: 4770, fn: transformDimensionResult, label: 'dimension results' },
  { file: '04_cr863_visualdefectresult2s.json', expect: 46, fn: transformDefectResult, label: 'defect results' },
  { file: '05_cr863_samplecoil2s.json', expect: 142, fn: transformSampleCoil, label: 'sample coils' },
  { file: '09_cr863_pdis.json', expect: 1, fn: transformPdi, label: 'PDI records' },
  { file: '24_cr863_auditlogs.json', expect: 31, fn: transformAuditLog, label: 'audit log' },
]

/** Images are a deliberate second pass — the files are on disk, not in the DB. */
const DEFERRED_IMAGE_FILES = [
  '06_cr863_visualdefectimages.json',
  '07_cr863_samplecoilimages.json',
  '08_quality_paintsampleimages.json',
  '10_cr863_pdiimages.json',
  '22_cr863_images.json',
]

// ============================================================================
// 5. Dry run
// ============================================================================

const exists = (p) => {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pad = (n, w = 9) => num(n).padStart(w)

export async function runDryRun(src, { verbose = false, log = console.log } = {}) {
  const report = {
    perCollection: new Map(),
    perFile: [],
    rejects: [],
    decodeFailures: [],
    counts: {},
    notes: [],
    problems: [],
  }
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
  const ctxBase = {
    decodeFailure: (f, id) => report.decodeFailures.push({ ...f, id }),
    count: (k) => (report.counts[k] = (report.counts[k] ?? 0) + 1),
  }

  // ---- Pre-pass: cross-file references ------------------------------------
  log('\n  Resolving cross-file references…')
  const orderIds = new Set()
  const orderWorkCenter = new Map()
  const sessionIds = new Set()
  const sessionMeta = new Map()
  const sessionInspector = new Map()
  const sessionInit = new Map()
  const sampleIds = new Set()
  const sampleIndex = new Map()
  const dimensionSequence = new Map()

  const f = (n) => path.join(src, n)

  if (exists(f('12_cr863_productionorder1s.json'))) {
    for await (const r of streamRows(f('12_cr863_productionorder1s.json'))) {
      const id = r.cr863_productionorder1id
      if (!id) continue
      orderIds.add(id)
      orderWorkCenter.set(id, String(r.cr863_workcenter ?? ''))
    }
  }
  if (exists(f('01_cr863_inspectionsession1s.json'))) {
    for await (const r of streamRows(f('01_cr863_inspectionsession1s.json'))) {
      const id = r.cr863_inspectionsession1id
      if (!id) continue
      sessionIds.add(id)
      sessionMeta.set(id, {
        orderId: r._cr863_productionorder_value ?? '',
        drawing: r.cr863_drawingno ?? '',
        issue: r.cr863_issueno ?? undefined,
      })
    }
  }
  // Session initialisations link by quality_sessionkey held as text, not by the
  // lookup column, which is empty.
  let initMatched = 0
  const initUnmatched = []
  if (exists(f('11_quality_sessioninitializations.json'))) {
    for await (const r of streamRows(f('11_quality_sessioninitializations.json'))) {
      const key = r.quality_sessionkey
      if (key && sessionIds.has(key)) {
        sessionInit.set(key, r)
        initMatched++
      } else {
        initUnmatched.push(r.quality_sessioninitializationid ?? '(no id)')
      }
    }
    report.notes.push(
      `Session initialisations joined on quality_sessionkey: ${initMatched} matched, ${initUnmatched.length} unmatched` +
        (initUnmatched.length ? ` — ${initUnmatched.join(', ')}` : ''),
    )
  }
  if (exists(f('02_cr863_inspectionsample1s.json'))) {
    const bySession = new Map()
    for await (const r of streamRows(f('02_cr863_inspectionsample1s.json'))) {
      const id = r.cr863_inspectionsample1id
      if (!id) continue
      sampleIds.add(id)
      const sid = r._cr863_inspectionsession_value ?? ''
      const arr = bySession.get(sid) ?? []
      arr.push({ id, at: r.cr863_sampledatetime ?? r.createdon ?? '', name: r.cr863_inspectorname ?? '' })
      bySession.set(sid, arr)
    }
    for (const [sid, arr] of bySession) {
      arr.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      arr.forEach((s, i) => sampleIndex.set(s.id, i + 1))
      // A session carries no inspector of its own; take it from its first sample.
      const first = arr.find((s) => s.name)
      if (first) sessionInspector.set(sid, first.name)
    }
  }
  if (exists(f('03_cr863_dimensionresult2s.json'))) {
    const bySample = new Map()
    for await (const r of streamRows(f('03_cr863_dimensionresult2s.json'))) {
      const id = r.cr863_dimensionresult2id
      if (!id) continue
      const sid = r._cr863_inspectionsample_value ?? ''
      const n = (bySample.get(sid) ?? 0) + 1
      bySample.set(sid, n)
      dimensionSequence.set(id, n)
    }
  }
  log(
    `    orders ${num(orderIds.size)} · sessions ${num(sessionIds.size)} · samples ${num(
      sampleIds.size,
    )} · initialisations ${num(initMatched)}\n`,
  )

  const ctx = {
    ...ctxBase,
    orderWorkCenter,
    session: sessionMeta,
    sessionInspector,
    sessionInit,
    sampleIndex,
    dimensionSequence,
  }

  const parentOf = {
    [COL.sessions]: (d) => (orderIds.has(d.orderId) ? null : `order ${d.orderId}`),
    [COL.samples]: (d) => (sessionIds.has(d.sessionId) ? null : `session ${d.sessionId}`),
    [COL.dimensions]: (d) => (sampleIds.has(d.sampleId) ? null : `sample ${d.sampleId}`),
    [COL.defects]: (d) => (sampleIds.has(d.sampleId) ? null : `sample ${d.sampleId}`),
    [COL.sampleCoils]: (d) => (sampleIds.has(d.sampleId) ? null : `sample ${d.sampleId}`),
  }

  // ---- Transform pass ------------------------------------------------------
  log('  file                        read      →  documents')
  log('  ' + '─'.repeat(54))
  let orphans = 0
  for (const spec of FILES) {
    const p = f(spec.file)
    if (!exists(p)) {
      report.problems.push(`missing file: ${spec.file}`)
      continue
    }
    let seen = 0
    let written = 0
    for await (const row of streamRows(p)) {
      seen++
      const out = spec.fn(row, ctx)
      if (out.reject) {
        report.rejects.push({ file: spec.file, ...out.reject })
        continue
      }
      const check = parentOf[out.collection]
      if (check) {
        const missing = check(out.doc)
        if (missing) {
          orphans++
          report.rejects.push({ file: spec.file, id: out.id, reason: `orphan — ${missing} not found` })
          continue
        }
      }
      bump(report.perCollection, out.collection)
      written++
    }
    report.perFile.push({ ...spec, seen, written })
    const flag = spec.expect != null && seen !== spec.expect ? `  ⚠ expected ${num(spec.expect)}` : ''
    log(`  ${spec.label.padEnd(22)} ${pad(seen)}  →  ${pad(written)}${flag}`)
  }

  // ---- Report --------------------------------------------------------------
  log('\n  ── Documents per collection ──────────────────────────')
  let total = 0
  for (const [col, n] of [...report.perCollection].sort((a, b) => b[1] - a[1])) {
    log(`  ${col.padEnd(24)} ${pad(n)}`)
    total += n
  }
  log(`  ${'TOTAL'.padEnd(24)} ${pad(total)}`)

  log('\n  ── Order status (cr863_accessstatus) ─────────────────')
  const statuses = Object.entries(report.counts).filter(([k]) => k.startsWith('status:'))
  if (statuses.length === 0) log('  none')
  for (const [k, v] of statuses.sort((a, b) => b[1] - a[1])) log(`  ${k.slice(7).padEnd(24)} ${pad(v)}`)

  log('\n  ── Grade extraction ──────────────────────────────────')
  const got = report.counts.gradeExtracted ?? 0
  const none = report.counts.gradeUnavailable ?? 0
  const pct = got + none ? ((got / (got + none)) * 100).toFixed(1) : '0.0'
  log(`  extracted ${pad(got)}   unavailable ${pad(none)}   (${pct}%)`)
  log('  Orders with no grade skip the mismatch check — no value is invented.')

  const dispositions = Object.entries(report.counts).filter(([k]) => k.startsWith('disposition:'))
  if (dispositions.length) {
    log('\n  ── Defect dispositions ───────────────────────────────')
    for (const [k, v] of dispositions.sort((a, b) => b[1] - a[1])) log(`  ${k.slice(12).padEnd(24)} ${pad(v)}`)
  }

  if (report.counts.measurementWithoutSpecification) {
    log('\n  ── Measurements with no specification ────────────────')
    log(`  ${pad(report.counts.measurementWithoutSpecification)} rows record a value with no nominal.`)
    log('  These import as Pending — unjudgeable is not a pass.')
  }

  log('\n  ── Rows with no home ─────────────────────────────────')
  if (report.rejects.length === 0) {
    log('  none')
  } else {
    const byReason = new Map()
    for (const r of report.rejects) bump(byReason, r.reason)
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) log(`  ${pad(n)}  ${reason}`)
    const show = verbose ? report.rejects : report.rejects.slice(0, 10)
    for (const r of show) log(`      ${r.file} ${r.id ?? ''} — ${r.reason}`)
    if (!verbose && report.rejects.length > 10) {
      log(`      … ${num(report.rejects.length - 10)} more (pass --verbose)`)
    }
  }

  log('\n  ── Orphans ───────────────────────────────────────────')
  log(orphans === 0 ? '  none — every child resolves to its parent' : `  ${num(orphans)}`)

  log('\n  ── Decode failures ───────────────────────────────────')
  if (report.decodeFailures.length === 0) {
    log('  none — every choice value was present in the metadata')
  } else {
    const byField = new Map()
    for (const d of report.decodeFailures) bump(byField, `${d.field} = ${d.value}`)
    for (const [k, n] of [...byField].sort((a, b) => b[1] - a[1])) log(`  ${pad(n)}  ${k}`)
  }

  if (report.notes.length) {
    log('\n  ── Notes ─────────────────────────────────────────────')
    for (const n of report.notes) log(`  · ${n}`)
  }

  log('\n  ── Deferred ──────────────────────────────────────────')
  log(`  ${DEFERRED_IMAGE_FILES.length} image tables are not part of this pass.`)
  log('  223 files (82 MB) upload separately so nothing is written twice.')

  if (report.problems.length) {
    log('\n  ── Problems ──────────────────────────────────────────')
    for (const p of report.problems) log(`  ! ${p}`)
  }

  log('\n  Dry run complete. Nothing was written, and no connection was opened.\n')
  return report
}

// ---- CLI -------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const verbose = process.argv.includes('--verbose')
  const src = args[0]
  if (!src) {
    console.log('\n  usage: node qc-dryrun.mjs <folder-with-the-24-json-files> [--verbose]\n')
    process.exit(1)
  }
  const resolved = path.resolve(src.replace(/^~/, process.env.HOME ?? '~'))
  if (!exists(resolved)) {
    console.error(`\n  Folder not found: ${resolved}\n`)
    process.exit(1)
  }
  console.log(`\n  Dataverse → QC System — DRY RUN`)
  console.log(`  source: ${resolved}`)
  runDryRun(resolved, { verbose }).catch((e) => {
    console.error('\n  Failed:', e.message)
    process.exit(1)
  })
}
