import type { DB, SampleResult } from '@/types'

export interface Kpis {
  sessions: number
  samples: number
  measurements: number
  defects: number
  passRate: number
  failRate: number
  warnRate: number
  holdCount: number
  openSessions: number
}

function inWindow(iso: string, sinceMs: number): boolean {
  return new Date(iso).getTime() >= sinceMs
}

export function computeKpis(db: DB, days: number): Kpis {
  const since = Date.now() - days * 86400000
  const sessions = db.sessions.filter((s) => inWindow(s.startedAt, since))
  const sessionIds = new Set(sessions.map((s) => s.id))
  const samples = db.samples.filter((s) => sessionIds.has(s.sessionId))
  const sampleIds = new Set(samples.map((s) => s.id))
  const dims = db.dimensions.filter((d) => sampleIds.has(d.sampleId))
  const defects = db.defects.filter((d) => sampleIds.has(d.sampleId))

  const counts = { Pass: 0, Fail: 0, Warning: 0, Pending: 0 } as Record<SampleResult, number>
  for (const s of samples) counts[s.result]++
  const decided = counts.Pass + counts.Fail + counts.Warning || 1

  return {
    sessions: sessions.length,
    samples: samples.length,
    measurements: dims.length,
    defects: defects.length,
    passRate: Math.round((counts.Pass / decided) * 100),
    failRate: Math.round((counts.Fail / decided) * 100),
    warnRate: Math.round((counts.Warning / decided) * 100),
    holdCount: defects.filter((d) => d.disposition === 'Hold').length,
    openSessions: sessions.filter((s) => s.status === 'Open').length,
  }
}

export interface TrendPoint {
  date: string
  label: string
  sessions: number
  samples: number
  defects: number
  pass: number
  fail: number
}

export function computeTrend(db: DB, days: number): TrendPoint[] {
  const buckets = Math.min(days, 30)
  const step = days / buckets
  const now = Date.now()
  const points: TrendPoint[] = []
  for (let i = buckets - 1; i >= 0; i--) {
    const end = now - i * step * 86400000
    const start = end - step * 86400000
    const d = new Date(end)
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const sessions = db.sessions.filter((s) => {
      const t = new Date(s.startedAt).getTime()
      return t >= start && t < end
    })
    const sessionIds = new Set(sessions.map((s) => s.id))
    const samples = db.samples.filter((s) => sessionIds.has(s.sessionId))
    const sampleIds = new Set(samples.map((s) => s.id))
    const defects = db.defects.filter((x) => sampleIds.has(x.sampleId))
    points.push({
      date: d.toISOString(),
      label,
      sessions: sessions.length,
      samples: samples.length,
      defects: defects.length,
      pass: samples.filter((x) => x.result === 'Pass').length,
      fail: samples.filter((x) => x.result === 'Fail').length,
    })
  }
  return points
}

export interface DefectBreakdown {
  title: string
  code: string
  count: number
  qty: number
}

export function computeDefectBreakdown(db: DB, days: number): DefectBreakdown[] {
  const since = Date.now() - days * 86400000
  const sessions = db.sessions.filter((s) => new Date(s.startedAt).getTime() >= since)
  const sessionIds = new Set(sessions.map((s) => s.id))
  const sampleIds = new Set(db.samples.filter((s) => sessionIds.has(s.sessionId)).map((s) => s.id))
  const defects = db.defects.filter((d) => sampleIds.has(d.sampleId))
  const map = new Map<string, DefectBreakdown>()
  for (const d of defects) {
    const key = d.title
    if (!map.has(key)) map.set(key, { title: d.title, code: d.defectCode, count: 0, qty: 0 })
    const e = map.get(key)!
    e.count++
    e.qty += d.qty
  }
  return Array.from(map.values()).sort((a, b) => b.qty - a.qty)
}

export interface MachinePerf {
  machine: string
  code: string
  samples: number
  pass: number
  fail: number
  passRate: number
}

export function computeMachinePerf(db: DB, days: number): MachinePerf[] {
  const since = Date.now() - days * 86400000
  const rows: MachinePerf[] = []
  for (const m of db.machines) {
    const sessions = db.sessions.filter(
      (s) => s.machineId === m.id && new Date(s.startedAt).getTime() >= since,
    )
    const sessionIds = new Set(sessions.map((s) => s.id))
    const samples = db.samples.filter((s) => sessionIds.has(s.sessionId))
    if (samples.length === 0) continue
    const pass = samples.filter((s) => s.result === 'Pass').length
    const fail = samples.filter((s) => s.result === 'Fail').length
    rows.push({
      machine: m.name,
      code: m.code,
      samples: samples.length,
      pass,
      fail,
      passRate: Math.round((pass / samples.length) * 100),
    })
  }
  return rows.sort((a, b) => b.samples - a.samples)
}
