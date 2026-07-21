import { useSyncExternalStore } from 'react'
import type {
  DB,
  ProductionOrder,
  InspectionSession,
  InspectionSample,
  DimensionResult,
  VisualDefectResult,
  InspectionImage,
  AuditLog,
  AuditAction,
  DefectType,
  DimensionSpec,
  GradeMapping,
  PTConsumable,
} from '@/types'
import { buildSeed } from '@/data/seed'
import { uid, nowISO } from '@/lib/utils'

const STORAGE_KEY = 'qc-system-db-v1'
const USER_KEY = 'qc-system-user'

function load(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DB
      if (parsed && parsed.meta && parsed.orders) return parsed
    }
  } catch {
    /* fall through to seed */
  }
  const seed = buildSeed()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
  } catch {
    /* storage may be full/unavailable */
  }
  return seed
}

let state: DB = load()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    // Most likely quota exceeded (too many images). Surface once.
    console.warn('QC persist failed', e)
  }
}

/** Replace state immutably and notify subscribers. */
function set(mutator: (draft: DB) => void) {
  const next: DB = structuredClone(state)
  mutator(next)
  state = next
  persist()
  emit()
}

export function getState(): DB {
  return state
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Reactive hook — re-renders when the DB changes. */
export function useDB(): DB {
  return useSyncExternalStore(subscribe, getState, getState)
}

// ---- Current user ----------------------------------------------------------
export function getUser(): string {
  return localStorage.getItem(USER_KEY) || 'Mohamed Abdelrahman'
}
export function setUser(name: string) {
  localStorage.setItem(USER_KEY, name)
  emit()
}

// ---- Audit helper ----------------------------------------------------------
function log(action: AuditAction, entity: string, entityRef: string, summary: string) {
  const entry: AuditLog = {
    id: uid('aud'),
    at: nowISO(),
    user: getUser(),
    action,
    entity,
    entityRef,
    summary,
  }
  state.audit.unshift(entry)
}

// ============================================================================
// Mutations
// ============================================================================

export const actions = {
  reset() {
    localStorage.removeItem(STORAGE_KEY)
    state = load()
    emit()
  },

  // --- Sessions ---
  createSession(input: {
    orderId: string
    machineId: string
    inspector?: string
    finalQty?: number
    confirm?: 'Pending' | 'Confirmed'
  }): InspectionSession {
    let created!: InspectionSession
    set((d) => {
      const seq = d.sessions.filter((s) => s.orderId === input.orderId).length + 1
      created = {
        id: uid('sess'),
        seq,
        orderId: input.orderId,
        machineId: input.machineId,
        inspector: input.inspector ?? getUser(),
        startedAt: nowISO(),
        status: 'Open',
        confirm: input.confirm ?? 'Pending',
        finalQty: input.finalQty,
      }
      d.sessions.unshift(created)
      const order = d.orders.find((o) => o.id === input.orderId)
      if (order && order.coverage === 'Not Started') order.coverage = 'In Progress'
      log('create', 'InspectionSession', order?.orderId ?? input.orderId, `Started inspection session #${seq}`)
    })
    return created
  },

  updateSession(id: string, patch: Partial<InspectionSession>) {
    set((d) => {
      const s = d.sessions.find((x) => x.id === id)
      if (!s) return
      Object.assign(s, patch)
      const order = d.orders.find((o) => o.id === s.orderId)
      log('update', 'InspectionSession', order?.orderId ?? id, `Updated session #${s.seq}`)
    })
  },

  setSessionQty(id: string, qty: number) {
    set((d) => {
      const s = d.sessions.find((x) => x.id === id)
      if (!s) return
      s.finalQty = qty
      s.confirm = 'Confirmed'
      const order = d.orders.find((o) => o.id === s.orderId)
      log('update', 'InspectionSession', order?.orderId ?? id, `Set quantity to ${qty} for session #${s.seq}`)
    })
  },

  closeSession(id: string, finalQty: number) {
    set((d) => {
      const s = d.sessions.find((x) => x.id === id)
      if (!s) return
      s.status = 'Closed'
      s.confirm = 'Confirmed'
      s.finalQty = finalQty
      s.closedAt = nowISO()
      const order = d.orders.find((o) => o.id === s.orderId)
      if (order) order.coverage = 'Inspected'
      log('close', 'InspectionSession', order?.orderId ?? id, `Closed session #${s.seq} (final qty ${finalQty})`)
    })
  },

  reopenSession(id: string) {
    set((d) => {
      const s = d.sessions.find((x) => x.id === id)
      if (!s) return
      s.status = 'Open'
      s.closedAt = undefined
      const order = d.orders.find((o) => o.id === s.orderId)
      log('reopen', 'InspectionSession', order?.orderId ?? id, `Reopened session #${s.seq}`)
    })
  },

  deleteSession(id: string) {
    set((d) => {
      const s = d.sessions.find((x) => x.id === id)
      const sampleIds = d.samples.filter((x) => x.sessionId === id).map((x) => x.id)
      d.samples = d.samples.filter((x) => x.sessionId !== id)
      d.dimensions = d.dimensions.filter((x) => !sampleIds.includes(x.sampleId))
      d.defects = d.defects.filter((x) => !sampleIds.includes(x.sampleId))
      d.images = d.images.filter((x) => x.sessionId !== id)
      d.sessions = d.sessions.filter((x) => x.id !== id)
      const order = d.orders.find((o) => o.id === s?.orderId)
      log('delete', 'InspectionSession', order?.orderId ?? id, `Deleted session #${s?.seq ?? '?'}`)
    })
  },

  // --- Samples ---
  addSample(sessionId: string, coilId?: string): InspectionSample {
    let created!: InspectionSample
    set((d) => {
      const idx = d.samples.filter((x) => x.sessionId === sessionId).length + 1
      const sess = d.sessions.find((x) => x.id === sessionId)
      created = {
        id: uid('smp'),
        sessionId,
        index: idx,
        label: `${idx}-1`,
        coilId,
        result: 'Pending',
        createdAt: nowISO(),
        inspector: sess?.inspector ?? getUser(),
      }
      d.samples.push(created)
      log('create', 'InspectionSample', created.label, `Added sample ${created.label}`)
    })
    return created
  },

  updateSample(id: string, patch: Partial<InspectionSample>) {
    set((d) => {
      const s = d.samples.find((x) => x.id === id)
      if (s) Object.assign(s, patch)
    })
  },

  deleteSample(id: string) {
    set((d) => {
      d.dimensions = d.dimensions.filter((x) => x.sampleId !== id)
      d.defects = d.defects.filter((x) => x.sampleId !== id)
      d.images = d.images.filter((x) => !(x.ownerKind === 'sample' && x.ownerId === id))
      d.samples = d.samples.filter((x) => x.id !== id)
    })
  },

  recomputeSample(sampleId: string) {
    set((d) => {
      const dims = d.dimensions.filter((x) => x.sampleId === sampleId)
      const defs = d.defects.filter((x) => x.sampleId === sampleId)
      const sample = d.samples.find((x) => x.id === sampleId)
      if (!sample) return
      if (defs.some((x) => x.disposition === 'Rejected')) sample.result = 'Fail'
      else if (dims.some((x) => x.result === 'Fail')) sample.result = 'Fail'
      else if (defs.some((x) => x.disposition === 'Hold')) sample.result = 'Warning'
      else if (dims.some((x) => x.result === 'Warning')) sample.result = 'Warning'
      else if (dims.length === 0 && defs.length === 0) sample.result = 'Pending'
      else if (dims.some((x) => x.result === 'Pending')) sample.result = 'Pending'
      else sample.result = 'Pass'
    })
  },

  // --- Dimensions ---
  addDimension(dim: Omit<DimensionResult, 'id'>): DimensionResult {
    let created!: DimensionResult
    set((d) => {
      created = { ...dim, id: uid('dim') }
      d.dimensions.push(created)
    })
    return created
  },
  updateDimension(id: string, patch: Partial<DimensionResult>) {
    set((d) => {
      const x = d.dimensions.find((y) => y.id === id)
      if (x) Object.assign(x, patch)
    })
  },
  deleteDimension(id: string) {
    set((d) => {
      d.dimensions = d.dimensions.filter((x) => x.id !== id)
    })
  },

  // --- Defects ---
  addDefect(def: Omit<VisualDefectResult, 'id'>): VisualDefectResult {
    let created!: VisualDefectResult
    set((d) => {
      created = { ...def, id: uid('def') }
      d.defects.push(created)
      log('create', 'VisualDefect', def.title, `Recorded defect "${def.title}" (${def.disposition})`)
    })
    return created
  },
  updateDefect(id: string, patch: Partial<VisualDefectResult>) {
    set((d) => {
      const x = d.defects.find((y) => y.id === id)
      if (x) Object.assign(x, patch)
    })
  },
  deleteDefect(id: string) {
    set((d) => {
      d.defects = d.defects.filter((x) => x.id !== id)
      d.images = d.images.filter((x) => !(x.ownerKind === 'defect' && x.ownerId === id))
    })
  },

  // --- Images ---
  addImage(img: Omit<InspectionImage, 'id' | 'createdAt'>): InspectionImage {
    let created!: InspectionImage
    set((d) => {
      created = { ...img, id: uid('img'), createdAt: nowISO() }
      d.images.push(created)
    })
    return created
  },
  deleteImage(id: string) {
    set((d) => {
      d.images = d.images.filter((x) => x.id !== id)
    })
  },

  // --- Orders ---
  upsertOrder(order: Partial<ProductionOrder> & { orderId: string }) {
    set((d) => {
      const existing = d.orders.find((o) => o.orderId === order.orderId)
      if (existing) {
        Object.assign(existing, order)
        log('update', 'ProductionOrder', order.orderId, `Updated order ${order.orderId}`)
      } else {
        d.orders.push({
          id: uid('o'),
          orderId: order.orderId,
          item: order.item ?? 'Unknown',
          itemCode: order.itemCode ?? '',
          machineId: order.machineId ?? d.machines[0].id,
          requiredQty: order.requiredQty ?? 0,
          finishedQty: order.finishedQty ?? 0,
          color: order.color ?? '',
          drawing: order.drawing ?? '',
          route: order.route ?? 'Local',
          date: order.date ?? nowISO(),
          status: order.status ?? 'Active',
          coverage: order.coverage ?? 'Not Started',
          nominalT: order.nominalT ?? 0,
          nominalW: order.nominalW ?? 0,
          nominalL: order.nominalL ?? 0,
        })
        log('create', 'ProductionOrder', order.orderId, `Created order ${order.orderId}`)
      }
    })
  },

  bulkImportOrders(rows: Array<Partial<ProductionOrder> & { orderId: string }>): { created: number; updated: number } {
    let createdN = 0
    let updatedN = 0
    set((d) => {
      for (const row of rows) {
        const existing = d.orders.find((o) => o.orderId === row.orderId)
        if (existing) {
          Object.assign(existing, row)
          updatedN++
        } else {
          d.orders.push({
            id: uid('o'),
            orderId: row.orderId,
            item: row.item ?? 'Imported',
            itemCode: row.itemCode ?? '',
            machineId: row.machineId ?? d.machines[0].id,
            requiredQty: row.requiredQty ?? 0,
            finishedQty: row.finishedQty ?? 0,
            color: row.color ?? '',
            drawing: row.drawing ?? '',
            route: row.route ?? 'Local',
            date: row.date ?? nowISO(),
            status: row.status ?? 'Active',
            coverage: 'Not Started',
            nominalT: row.nominalT ?? 0,
            nominalW: row.nominalW ?? 0,
            nominalL: row.nominalL ?? 0,
          })
          createdN++
        }
      }
      log('import', 'ProductionOrder', `${rows.length} rows`, `Bulk import: ${createdN} created, ${updatedN} updated`)
    })
    return { created: createdN, updated: updatedN }
  },

  // --- Lookup CRUD ---
  saveDefectType(row: DefectType) {
    set((d) => {
      const i = d.defectTypes.findIndex((x) => x.id === row.id)
      if (i >= 0) d.defectTypes[i] = row
      else d.defectTypes.push({ ...row, id: row.id || uid('dt') })
      log('update', 'DefectType', row.code, `Saved defect type ${row.code}`)
    })
  },
  deleteDefectType(id: string) {
    set((d) => {
      d.defectTypes = d.defectTypes.filter((x) => x.id !== id)
    })
  },
  saveDimensionSpec(row: DimensionSpec) {
    set((d) => {
      const i = d.dimensionSpecs.findIndex((x) => x.id === row.id)
      if (i >= 0) d.dimensionSpecs[i] = row
      else d.dimensionSpecs.push({ ...row, id: row.id || uid('ds') })
      log('update', 'DimensionSpec', row.code, `Saved dimension ${row.code}`)
    })
  },
  deleteDimensionSpec(id: string) {
    set((d) => {
      d.dimensionSpecs = d.dimensionSpecs.filter((x) => x.id !== id)
    })
  },
  saveGradeMapping(row: GradeMapping) {
    set((d) => {
      const i = d.gradeMappings.findIndex((x) => x.id === row.id)
      if (i >= 0) d.gradeMappings[i] = row
      else d.gradeMappings.push({ ...row, id: row.id || uid('g') })
    })
  },
  savePTConsumable(row: PTConsumable) {
    set((d) => {
      const i = d.ptConsumables.findIndex((x) => x.id === row.id)
      if (i >= 0) d.ptConsumables[i] = row
      else d.ptConsumables.push({ ...row, id: row.id || uid('pt') })
    })
  },
  deletePTConsumable(id: string) {
    set((d) => {
      d.ptConsumables = d.ptConsumables.filter((x) => x.id !== id)
    })
  },
}
