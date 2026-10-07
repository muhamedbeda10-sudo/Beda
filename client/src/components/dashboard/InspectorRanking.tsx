// ============================================================================
// §16 — the inspector ranking.
//
// A ranking of people is read differently from a chart of machines, so this
// says out loud what it measures and what it refuses to measure. It ranks the
// inspection — how much was covered, how completely it was recorded, how
// rarely it had to be corrected, and how the defects found compare with what
// peers find on the same machine. It does NOT rank the defect rate of the
// work inspected: that would reward whoever finds least.
// ============================================================================

import { useState } from 'react'
import { Award, ChevronRight, Info, Medal, Trophy } from 'lucide-react'
import type { KpiInspectorGroup, KpiInspectorRank, KpiInspectorRanking } from '@qc/shared/kpi'
import { Badge, Card } from '@/components/ui'
import { FilterNote, FilterTh, useColumnFilters } from '@/components/dashboard/filters'
import { cn } from '@/lib/utils'

const num = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: digits })

/** Gold, silver, bronze — the only three places a podium has. */
const PODIUM = [
  { icon: Trophy, ring: 'ring-amber-300 dark:ring-amber-500/40', bg: 'bg-amber-50 dark:bg-amber-500/10', text: 'text-amber-700 dark:text-amber-300', label: '1st' },
  { icon: Medal, ring: 'ring-slate-300 dark:ring-slate-500/40', bg: 'bg-slate-50 dark:bg-slate-500/10', text: 'text-slate-600 dark:text-slate-300', label: '2nd' },
  { icon: Award, ring: 'ring-orange-300 dark:ring-orange-500/40', bg: 'bg-orange-50 dark:bg-orange-500/10', text: 'text-orange-700 dark:text-orange-300', label: '3rd' },
]

/** The four parts of a score, in the order they are weighted. */
const PARTS: { key: keyof KpiInspectorRank; label: string; weight: number; bar: string }[] = [
  { key: 'completenessScore', label: 'Completeness', weight: 35, bar: 'bg-brand-500' },
  { key: 'coverageScore', label: 'Coverage', weight: 30, bar: 'bg-emerald-500' },
  { key: 'accuracyScore', label: 'Accuracy', weight: 20, bar: 'bg-violet-500' },
  { key: 'detectionScore', label: 'Detection', weight: 15, bar: 'bg-sky-500' },
]

function PartBars({ row }: { row: KpiInspectorRank }) {
  return (
    <div className="mt-2 space-y-1">
      {PARTS.map((p) => (
        <div key={p.key} className="flex items-center gap-2">
          <span className="w-[86px] shrink-0 text-[11px] text-muted">{p.label}</span>
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <span className={cn('block h-full rounded-full', p.bar)} style={{ width: `${Math.max(0, Math.min(100, row[p.key] as number))}%` }} />
          </span>
          <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums text-muted">
            {num(row[p.key] as number)}
          </span>
        </div>
      ))}
    </div>
  )
}

function Podium({ rows, onPick }: { rows: KpiInspectorRank[]; onPick: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {rows.map((r, i) => {
        const place = PODIUM[i]
        const Icon = place.icon
        return (
          <button
            key={r.inspectorId}
            type="button"
            onClick={() => onPick(r.inspectorId)}
            className={cn('card-hover rounded-2xl p-4 text-left ring-1', place.ring, place.bg)}
          >
            <div className="flex items-center gap-2">
              <Icon className={cn('h-5 w-5 shrink-0', place.text)} />
              <span className={cn('text-xs font-bold uppercase tracking-wide', place.text)}>{place.label}</span>
              <span className="ml-auto text-2xl font-extrabold tabular-nums">{num(r.score, 1)}</span>
            </div>
            <p dir="auto" className="mt-1 truncate text-sm font-bold">{r.name}</p>
            <p className="text-xs text-muted">
              {num(r.samples)} samples · {num(r.samplesPerActiveDay, 1)}/day · {num(r.pieces)} pcs
            </p>
            <PartBars row={r} />
          </button>
        )
      })}
    </div>
  )
}

function RankTable({ rows, onPick }: { rows: KpiInspectorRank[]; onPick: (id: string) => void }) {
  const filters = useColumnFilters(rows, [
    { key: 'rank', value: (r) => String(r.rank), numeric: true },
    { key: 'name', value: (r) => r.name },
    { key: 'score', value: (r) => num(r.score, 1), numeric: true },
    ...PARTS.map((p) => ({ key: p.key, value: (r: KpiInspectorRank) => num(r[p.key] as number), numeric: true })),
    { key: 'samples', value: (r) => num(r.samples), numeric: true },
    { key: 'perDay', value: (r) => num(r.samplesPerActiveDay, 1), numeric: true },
    { key: 'dims', value: (r) => (r.dimensionCompletionPct === null ? '—' : `${num(r.dimensionCompletionPct, 1)}%`), numeric: true },
    { key: 'corrections', value: (r) => num(r.correctionsPer100Samples, 1), numeric: true },
  ])
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <FilterTh filters={filters} column="rank" label="#" />
            <FilterTh filters={filters} column="name" label="Inspector" />
            <FilterTh filters={filters} column="score" label="Score" className="text-right" />
            {PARTS.map((p) => (
              <FilterTh key={p.key} filters={filters} column={p.key} label={p.label} className="text-right" />
            ))}
            <FilterTh filters={filters} column="samples" label="Samples" className="text-right" />
            <FilterTh filters={filters} column="perDay" label="Per day" className="text-right" />
            <FilterTh filters={filters} column="dims" label="Dims measured" className="text-right" />
            <FilterTh filters={filters} column="corrections" label="Corrections /100" className="text-right" />
            <th className="print-hidden px-2 py-1.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {filters.rows.map((r) => (
            <tr
              key={r.inspectorId}
              onClick={() => onPick(r.inspectorId)}
              className="cursor-pointer transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/40"
            >
              <td className="px-2 py-1.5 tabular-nums text-muted">{r.rank}</td>
              <td dir="auto" className="px-2 py-1.5 font-semibold">{r.name}</td>
              <td className="px-2 py-1.5 text-right font-bold tabular-nums">{num(r.score, 1)}</td>
              {PARTS.map((p) => (
                <td key={p.key} className="px-2 py-1.5 text-right tabular-nums text-muted">
                  {num(r[p.key] as number)}
                </td>
              ))}
              <td className="px-2 py-1.5 text-right tabular-nums">{num(r.samples)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{num(r.samplesPerActiveDay, 1)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.dimensionCompletionPct === null ? '—' : `${num(r.dimensionCompletionPct, 1)}%`}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{num(r.correctionsPer100Samples, 1)}</td>
              <td className="print-hidden px-2 py-1.5 text-right">
                <ChevronRight className="ml-auto h-4 w-4 text-muted" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <FilterNote filters={filters} total={rows.length} />
    </div>
  )
}

export function InspectorRanking({ data, onPick }: { data: KpiInspectorRanking; onPick: (id: string) => void }) {
  // One tab per factory when there is more than one; with a single factory the
  // overall list is that factory's list, and a tab row would say nothing.
  const tabs: { key: string; label: string; group: KpiInspectorGroup }[] = [
    { key: '', label: 'All factories', group: data.overall },
    ...data.byFactory.map((g) => ({ key: g.factory || 'none', label: g.factory || 'No factory', group: g })),
  ]
  const [tab, setTab] = useState('')
  const shown = (data.byFactory.length > 1 ? tabs.find((t) => t.key === tab) : undefined) ?? tabs[0]
  const [explain, setExplain] = useState(false)
  const { ranked, unranked } = shown.group

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {data.byFactory.length > 1 &&
          tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'min-h-[36px] rounded-xl px-3 text-xs font-semibold ring-1 transition-colors',
                shown.key === t.key
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : 'ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800',
              )}
            >
              {t.label}
            </button>
          ))}
        <button
          type="button"
          onClick={() => setExplain((v) => !v)}
          className="print-hidden ml-auto inline-flex min-h-[36px] items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300"
        >
          <Info className="h-3.5 w-3.5" /> {explain ? 'Hide' : 'How is this scored?'}
        </button>
      </div>

      {explain && (
        <Card className="space-y-2 p-4 text-sm">
          <p className="font-semibold">The score is of the inspection, not of the product.</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-600 dark:text-slate-300">
            <li>
              <span className="font-semibold">Completeness 35%</span> — dimensions actually measured of those listed, coils taken from the register instead of
              typed, sessions closed with a final quantity, sessions opened and left empty.
            </li>
            <li>
              <span className="font-semibold">Coverage 30%</span> — samples per day actually worked, pieces inspected, order lines covered.
            </li>
            <li>
              <span className="font-semibold">Accuracy 20%</span> — how rarely the record had to be corrected or re-recorded afterwards.
            </li>
            <li>
              <span className="font-semibold">Detection 15%</span> — defects found per piece against what other inspectors find on the same machine. Parity with
              peers scores 50; twice their rate scores 100.
            </li>
          </ul>
          <p className="text-muted">
            The defect rate of the work inspected is deliberately not part of the score: ranking on it would reward the inspector who finds least. An inspector
            needs {data.minSamples} samples in the period to be placed at all.
          </p>
        </Card>
      )}

      {ranked.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          No inspector reached {data.minSamples} samples in this period.
        </p>
      ) : (
        <>
          <Podium rows={ranked.slice(0, 3)} onPick={onPick} />
          {ranked.length > 3 && <RankTable rows={ranked.slice(3)} onPick={onPick} />}
        </>
      )}

      {unranked.length > 0 && (
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
          <p className="text-xs font-semibold text-muted">
            Not placed — under {data.minSamples} samples in this period
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {unranked.map((r) => (
              <Badge key={r.inspectorId} tone="neutral">
                <span dir="auto">{r.name}</span> · {num(r.samples)}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
