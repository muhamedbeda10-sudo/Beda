import type {
  DB,
  InspectionSession,
  ProductionOrder,
  Machine,
  InspectionSample,
} from '@/types'

export function machineById(db: DB, id?: string): Machine | undefined {
  return db.machines.find((m) => m.id === id)
}
export function orderById(db: DB, id?: string): ProductionOrder | undefined {
  return db.orders.find((o) => o.id === id)
}
export function orderByBusinessId(db: DB, orderId?: string): ProductionOrder | undefined {
  return db.orders.find((o) => o.orderId === orderId)
}

export function samplesOf(db: DB, sessionId: string): InspectionSample[] {
  return db.samples.filter((s) => s.sessionId === sessionId).sort((a, b) => a.index - b.index)
}
export function dimsOf(db: DB, sampleId: string) {
  return db.dimensions.filter((d) => d.sampleId === sampleId)
}
export function defectsOf(db: DB, sampleId: string) {
  return db.defects.filter((d) => d.sampleId === sampleId)
}
export function imagesOf(db: DB, ownerKind: 'sample' | 'defect', ownerId: string) {
  return db.images.filter((i) => i.ownerKind === ownerKind && i.ownerId === ownerId)
}
export function sessionImages(db: DB, sessionId: string) {
  return db.images.filter((i) => i.sessionId === sessionId)
}

export function sessionDefects(db: DB, sessionId: string) {
  const sampleIds = new Set(samplesOf(db, sessionId).map((s) => s.id))
  return db.defects.filter((d) => sampleIds.has(d.sampleId))
}

export function sessionHasHold(db: DB, sessionId: string): boolean {
  return sessionDefects(db, sessionId).some((d) => d.disposition === 'Hold')
}

export interface SessionView extends InspectionSession {
  order?: ProductionOrder
  machine?: Machine
  sampleCount: number
  defectCount: number
  holdCount: number
}

export function sessionView(db: DB, session: InspectionSession): SessionView {
  const order = orderById(db, session.orderId)
  const machine = machineById(db, session.machineId)
  const samples = samplesOf(db, session.id)
  const defects = sessionDefects(db, session.id)
  return {
    ...session,
    order,
    machine,
    sampleCount: samples.length,
    defectCount: defects.length,
    holdCount: defects.filter((d) => d.disposition === 'Hold').length,
  }
}

/** Group open+recent sessions by machine for the Inspections landing page. */
export interface MachineGroup {
  machine: Machine
  sessions: SessionView[]
  sampleCount: number
}

export function groupSessionsByMachine(db: DB, sessions: InspectionSession[]): MachineGroup[] {
  const map = new Map<string, MachineGroup>()
  for (const s of sessions) {
    const machine = machineById(db, s.machineId)
    if (!machine) continue
    if (!map.has(machine.id)) map.set(machine.id, { machine, sessions: [], sampleCount: 0 })
    const g = map.get(machine.id)!
    const view = sessionView(db, s)
    g.sessions.push(view)
    g.sampleCount += view.sampleCount
  }
  return Array.from(map.values())
}
