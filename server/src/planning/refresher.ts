// ============================================================================
// §25 — planning kept fresh in the background, on every instance: what the
// record says is learnt again every six hours (and soon after a start when it
// never was), and the automatic plan is kept every half hour, so the AI
// assistant reads a plan no older than that. Learning takes a lock, so one
// instance does it at a time; keeping the plan skips a row another holds.
// ============================================================================

import type { Config } from '../config'
import type { Db } from '../db/pool'
import { learnFromRecord } from './learn'
import { keepAutoPlan } from './plans'

const KEEP_EVERY_MS = 30 * 60_000
const LEARN_EVERY_MS = 6 * 60 * 60_000
const FIRST_RUN_MS = 60_000

export class PlanningRefresher {
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private running: Promise<unknown> | null = null
  private lastLearnt = 0

  constructor(private readonly deps: { db: Db; config: Config }) {}

  start(): void {
    if (this.timer) return
    this.first = setTimeout(() => this.tick(), FIRST_RUN_MS)
    this.first.unref()
    this.timer = setInterval(() => this.tick(), KEEP_EVERY_MS)
    this.timer.unref()
  }

  private tick(): void {
    if (this.running) return
    this.running = this.run()
      .catch((e) => console.warn('[planning] could not refresh:', e instanceof Error ? e.message : String(e)))
      .finally(() => {
        this.running = null
      })
  }

  private async run(): Promise<void> {
    const { db, config } = this.deps
    if (Date.now() - this.lastLearnt >= LEARN_EVERY_MS) {
      const { rows } = await db.query<{ at: string | null }>(`SELECT learnt_at AS at FROM planning_learnt`)
      const at = rows[0]?.at ? Date.parse(rows[0].at) : 0
      if (Date.now() - at >= LEARN_EVERY_MS) await learnFromRecord(db, config.FACTORY_TIMEZONE)
      this.lastLearnt = Date.now()
    }
    await keepAutoPlan(db, config)
  }

  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null
    this.timer = null
    await this.running
  }
}
