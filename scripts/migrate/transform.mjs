// ============================================================================
// Dataverse row -> Firestore document.
//
// Pure functions: a row in, a { doc, collection } or a rejection out. No I/O,
// no Firestore, so the whole mapping is testable before it touches real data.
//
// Every transform returns `{ doc }` or `{ reject: { reason, ... } }`. A row is
// never silently dropped — a rejection is reported, counted and, in the dry
// run, printed with its row identity.
// ============================================================================

import {
  SESSION_STATUS,
  SHIFT,
  DIMENSION_STATUS,
  DEFECT_STATUS,
  AUDIT_ACTION,
  decodeChoice,
  decodeRoute,
  decodeOrderStatus,
  extractGrade,
  isoOrNull,
  numOrNull,
  strOrNull,
  legacyUid,
} from './decode.mjs'

/** Target collection names — must match src/services/repository.ts COL. */
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

/** Drop Dataverse system noise; keep only what carries meaning. */
function reject(reason, extra = {}) {
  return { reject: { reason, ...extra } }
}

// ---- Reference data --------------------------------------------------------

export function transformOrder(r, ctx) {
  const id = r.cr863_productionorder1id
  if (!id) return reject('missing primary key')

  const route = decodeRoute(r.cr863_explocal)
  if (route.failure) ctx.decodeFailure(route.failure, id)
  const status = decodeOrderStatus(r.cr863_accessstatus)
  if (status.failure) ctx.decodeFailure(status.failure, id)

  // 65% of orders carry no raw-material description; those keep a null grade
  // and the mismatch check skips rather than comparing against an invention.
  const grade = extractGrade(r.cr863_rawmaterialdescription)
  if (grade) ctx.count('gradeExtracted')
  else ctx.count('gradeUnavailable')

  return {
    collection: COL.orders,
    id,
    doc: {
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
      // Planning data with no home in the model — kept verbatim, not discarded.
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
    },
  }
}

export function transformMachine(r) {
  const id = r.cr863_machinesid
  if (!id) return reject('missing primary key')
  const code = strOrNull(r.cr863_workcenter) ?? ''
  // The columns are inverted relative to their names: machinename holds the
  // line (LM1..LM4) and factory holds the work-centre process name. The old app
  // laboured this out as "{workcenter}-{factory}-{machinename}".
  const name = strOrNull(r.cr863_factory) ?? ''
  const line = strOrNull(r.cr863_machinename) ?? ''
  return {
    collection: COL.machines,
    id,
    doc: {
      id,
      legacyId: id,
      code,
      name,
      line,
      displayName: [code, name, line].filter(Boolean).join('-'),
    },
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
      // Images are a separate migration pass; the row carries its source URL
      // until the file is uploaded and a real imageId replaces it.
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

// ---- Transactional ---------------------------------------------------------

export function transformSession(r, ctx) {
  const id = r.cr863_inspectionsession1id
  if (!id) return reject('missing primary key')
  const orderId = strOrNull(r._cr863_productionorder_value)
  if (!orderId) return reject('session has no production order', { id })

  const status = decodeChoice(SESSION_STATUS, 'cr863_sessionstatus', r.cr863_sessionstatus, 'Open')
  if (status.failure) ctx.decodeFailure(status.failure, id)

  const startedAt = isoOrNull(r.cr863_sessiondatetime) ?? isoOrNull(r.createdon) ?? ''
  const qty = numOrNull(r.cr863_qty)
  // Session initialisation rows link by quality_sessionkey, stored as text
  // rather than as a lookup. isConfirmed is true for all 71 of them.
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
      // Filled from the session's first sample where one exists.
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
      // Deterministic, so re-running the migration cannot duplicate a sample.
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

  // A null status is "not evaluated", not a pass.
  const status = decodeChoice(DIMENSION_STATUS, 'cr863_status', r.cr863_status, 'Pending')
  if (status.failure) ctx.decodeFailure(status.failure, id)

  return {
    collection: COL.dimensions,
    id,
    doc: pruned({
      id,
      legacyId: id,
      sampleId,
      name: strOrNull(r.cr863_dimensionname) ?? '',
      sequence: ctx.dimensionSequence?.get(id) ?? 0,
      nominal: numOrNull(r.cr863_nominal),
      tolPlus: numOrNull(r.cr863_toleranceplus),
      tolMinus: numOrNull(r.cr863_toleranceminus),
      actual: numOrNull(r.cr863_actual),
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
  // Only Update and Delete exist upstream. Creation was logged as Update, so a
  // Create action is never synthesised here.
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
