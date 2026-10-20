// ============================================================================
// §25 — bettering the priority order. The engine takes the lines in a fixed
// order and never looks back; a line that misses its due day by an hour
// may sit behind one that had days to spare. The optimiser is a local
// search on that order: it works the plan out as the priority rule gives
// it, then tries, late line by late line, to move each one ahead of the
// line before it on its machine (or to the front of the machine's queue),
// works the plan out again — the same engine, every constraint kept — and
// keeps the move when the objective gets smaller.
//
// Deterministic on purpose: the moves are tried in a fixed order and the
// budget is a number of plans worked out, scaled by the size of the record
// rather than by the clock, so the same inputs give the same plan on any
// machine and a scenario compared with its base is compared fairly. A big
// record gets fewer tries; it says how many it got.
// ============================================================================

import { resolveSettings, runPlan, type PlanInputs } from './engine'
import type { OptimiseEffort, PlanObjective, PlanOperation, PlanResult } from './types'

/** Plans worked out at most, and the "plans × lines" the budget is spread over, per effort. */
const BUDGET: Record<Exclude<OptimiseEffort, 'off'>, { maxEvaluations: number; lineEvaluations: number }> = {
  light: { maxEvaluations: 40, lineEvaluations: 12_000 },
  full: { maxEvaluations: 250, lineEvaluations: 100_000 },
}

/** How many plans the optimiser may work out for a record of `lines` lines. */
export function evaluationBudget(effort: OptimiseEffort, lines: number): number {
  if (effort === 'off' || lines === 0) return 0
  const b = BUDGET[effort]
  return Math.min(b.maxEvaluations, Math.floor(b.lineEvaluations / lines))
}

/** A line's weight in tonnes for the objective; a line with no weight counts as one tonne, so it still counts. */
const tonnesOf = (op: PlanOperation) => (op.weightKg !== null && op.weightKg > 0 ? op.weightKg / 1000 : 1)

/**
 * The objective as a tuple compared element by element: unplaced lines first (never worth more), then the tonnes left
 * unplaced (a heavy line left out is worse than a light one), then what the objective names.
 */
export function score(result: PlanResult, objective: PlanObjective): number[] {
  let lateLines = 0
  let lateDays = 0
  let lateTonneDays = 0
  let unplaced = 0
  let unplacedTonnes = 0
  for (const op of result.operations) {
    if (op.end === null) {
      unplaced++
      unplacedTonnes += tonnesOf(op)
    }
    if (op.lateDays <= 0) continue
    lateLines++
    lateDays += op.lateDays
    lateTonneDays += op.lateDays * tonnesOf(op)
  }
  lateTonneDays = Math.round(lateTonneDays * 1000) / 1000
  unplacedTonnes = Math.round(unplacedTonnes * 1000) / 1000
  switch (objective) {
    case 'late-lines':
      return [unplaced, unplacedTonnes, lateLines, lateDays, lateTonneDays]
    case 'late-days':
      return [unplaced, unplacedTonnes, lateDays, lateLines, lateTonneDays]
    default:
      return [unplaced, unplacedTonnes, lateTonneDays, lateLines, lateDays]
  }
}

const better = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true
    if (a[i] > b[i]) return false
  }
  return false
}

interface Move {
  /** The late (or unplaced) line moved earlier. */
  lineId: string
  /** The line it goes ahead of. */
  beforeId: string
}

/** How much a line's lateness weighs when choosing what to try first: the objective's own measure; an unplaced line weighs most. */
function urgency(op: PlanOperation, objective: PlanObjective): number {
  if (op.end === null) return Number.MAX_SAFE_INTEGER
  if (objective === 'late-lines') return 1 + op.lateDays / 1e6
  if (objective === 'late-days') return op.lateDays
  return op.lateDays * tonnesOf(op)
}

/**
 * The moves worth trying on a plan, in the objective's order of urgency: each late or unplaced line ahead of the one
 * before it on its machine, then to the front of its queue. Never past the line running now, a rushed line, or a
 * line it waits for.
 */
function candidateMoves(result: PlanResult, objective: PlanObjective): Move[] {
  const byMachine = new Map<string, PlanOperation[]>()
  for (const op of result.operations) {
    const l = byMachine.get(op.machineKey)
    if (l) l.push(op)
    else byMachine.set(op.machineKey, [op])
  }
  for (const l of byMachine.values()) l.sort((a, b) => a.seq - b.seq)
  const fixed = (op: PlanOperation) => op.flags.includes('running') || op.flags.includes('rushed')
  const late = result.operations
    .filter((op) => (op.lateDays > 0 || op.end === null) && !fixed(op))
    .sort((a, b) => urgency(b, objective) - urgency(a, objective) || b.lateDays - a.lateDays || a.lineId.localeCompare(b.lineId))
  const moves: Move[] = []
  for (const op of late) {
    const queue = byMachine.get(op.machineKey)!
    const i = queue.findIndex((o) => o.lineId === op.lineId)
    const prev = i > 0 ? queue[i - 1] : null
    if (prev && !fixed(prev) && !op.dependsOn.includes(prev.lineKey)) moves.push({ lineId: op.lineId, beforeId: prev.lineId })
    const first = queue.find((o) => !fixed(o))
    if (first && first !== op && first !== prev && !op.dependsOn.includes(first.lineKey)) moves.push({ lineId: op.lineId, beforeId: first.lineId })
  }
  return moves
}

/** Ranks from an order of line ids: a plan's `order`, to start another search where it ended. */
export function ranksOf(order: readonly string[]): Map<string, number> {
  return new Map(order.map((id, i) => [id, i]))
}

/**
 * The plan with the optimiser's order: the priority order's plan when the
 * settings turn it off (or the record is too big for even one try), else
 * the best of what it found, saying what the priority order gave. Given
 * `startFrom` (another plan's `order`, say the plan a scenario was made
 * from), the search starts from that order when it is the better of the
 * two, so what differs between the two plans is the scenario's changes and
 * the moves they make possible, not a search that went another way.
 */
export function optimisePlan(inputs: PlanInputs, options: { startFrom?: readonly string[] } = {}): PlanResult {
  const settings = resolveSettings(inputs.settings)
  const baseline = runPlan(inputs)
  const objective = settings.objective
  const baselineScore = score(baseline, objective)
  const note = (best: PlanResult, bestScore: number[], evaluations: number, moves: number): PlanResult => ({
    ...best,
    optimisation: { objective, effort: settings.optimise, baseline: baseline.summary, baselineScore: baselineScore[2], score: bestScore[2], evaluations, moves, improved: moves > 0 },
  })
  if (settings.optimise === 'off') return note(baseline, baselineScore, 0, 0)
  const budget = evaluationBudget(settings.optimise, baseline.operations.length)
  if (budget === 0) return note(baseline, baselineScore, 0, 0)

  // Ranks: the priority order's positions (or the order started from, when it does better), then changed move by move.
  let rank = ranksOf(baseline.order ?? [])
  let best = baseline
  let bestScore = baselineScore
  let evaluations = 0
  let moves = 0
  if (options.startFrom && options.startFrom.length > 0) {
    const started = ranksOf(options.startFrom)
    const trial = runPlan({ ...inputs, priority: started })
    evaluations++
    const s = score(trial, objective)
    if (better(s, bestScore)) {
      // The lines the start knows keep its order; any other (an order a scenario adds) comes after them, by the rule.
      rank = ranksOf(trial.order ?? [])
      best = trial
      bestScore = s
      moves++
    }
  }
  while (evaluations < budget) {
    let accepted = false
    for (const m of candidateMoves(best, objective)) {
      if (evaluations >= budget) break
      const was = rank.get(m.lineId)
      const target = rank.get(m.beforeId)
      if (was === undefined || target === undefined || was <= target) continue
      // Just ahead of the line it passes; nothing else moves.
      rank.set(m.lineId, target - 0.5)
      const trial = runPlan({ ...inputs, priority: rank })
      evaluations++
      const s = score(trial, objective)
      if (better(s, bestScore)) {
        best = trial
        bestScore = s
        moves++
        accepted = true
        break
      }
      rank.set(m.lineId, was)
    }
    if (!accepted) break
  }
  return note(best, bestScore, evaluations, moves)
}
