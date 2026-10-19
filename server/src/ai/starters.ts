// ============================================================================
// §20 — what the assistant starts with: reports and a saved table built as
// the assistant builds them (save_report, save_table), kept as its owner's
// and shared with everyone given the assistant. They are ordinary reports
// and tables from then on: the assistant reads them (read_report,
// list_saved_tables), changes them at the owner's word, and builds others on
// them. Each is made once, the first time the server starts with an owner
// and the data's reader ready: one the owner deleted is not made again.
//
//   • standard_times — pieces per hour of each item on each machine, from
//     the ERP's production record of the last year (rows with actual hours),
//     computed every night: the standard a run is compared against.
//   • Order tracking — orders (an order number stands for all its phases,
//     20332-Ph2.2 for one): the headline figures, each order and phase, the
//     main items with their parts and the machines each passed (a tree),
//     each machine, what is late or overdue, where the pieces stand, and the
//     pieces per hour against the standard.
//   • Week tracking — a planning week (the order sheet's Pivot column), with
//     orders to take alone or to leave out: the week's figures, each
//     machine, each order, and what is missing, where.
//
// How the figures are counted is said in each report's description: an item
// that passes several machines is finished as far as the machine that has
// done the least of it; the weight of a line is counted once, however many
// machines it passes; the reject rate is the dashboard's, rejected ÷
// (finished + rejected), from the inspection record.
// ============================================================================

import type { AiReportSection } from '@qc/shared/ai'
import type { AiReportInput } from '@qc/shared/aiReportInputs'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { loadAccess } from './access'
import { currentAiOwner } from './owner'
import { insertReport } from './reports'
import { saveTable, type SavedTableReaders } from './savedTables'

// ---- The standard times ---------------------------------------------------------------

export const STANDARD_TIMES_TABLE = 'standard_times'

const STANDARD_TIMES_SQL = `SELECT r.item_code,
       r.work_center_code AS machine_code,
       max(r.machine) AS machine,
       count(*) AS records,
       sum(r.produced_qty) AS pieces,
       round(sum(r.actual_hours)::numeric, 2) AS hours,
       round((sum(r.produced_qty) / nullif(sum(r.actual_hours), 0))::numeric, 2) AS pieces_per_hour,
       round((60 * sum(r.actual_hours) / nullif(sum(r.produced_qty), 0))::numeric, 3) AS minutes_per_piece,
       round((sum(r.produced_weight_kg) / nullif(sum(r.actual_hours), 0))::numeric, 1) AS kg_per_hour,
       min(r.work_day) AS first_day,
       max(r.work_day) AS last_day
  FROM ai.production_task_records r
 WHERE r.item_code IS NOT NULL AND btrim(r.item_code) <> ''
   AND r.produced_qty > 0 AND r.actual_hours > 0
   AND r.work_day >= current_date - 365
 GROUP BY r.item_code, r.work_center_code
HAVING count(*) >= 3`

// ---- Order tracking ------------------------------------------------------------------

/** An order number standing for itself and all its phases (20332 → 20332-Ph2.2-EHF), or a phase alone. */
const ORDERS_MATCH = `EXISTS (SELECT 1 FROM unnest({{orders}}) AS p(v)
                WHERE lower(o.order_number) = lower(btrim(p.v))
                   OR left(lower(o.order_number), length(btrim(p.v)) + 1) = lower(btrim(p.v)) || '-')`

/**
 * The order lines asked for, each with what the inspection record and the production record add: its main item and
 * part (from the ERP's Parent ID: 0118-20332-Ph2.2-EHF-0000 is the main item of group 0118-20332-Ph2.2-EHF-, -0100 its
 * first part), its rejected and repaired pieces, the last day it made anything, and how it stands against its due date.
 */
const lineCtes = (where: string) => `WITH line AS (
  SELECT o.order_line_id, o.line_key, o.order_number, o.customer, o.item, o.item_code, o.machine_code,
         COALESCE(NULLIF(o.machine, ''), o.machine_code) AS machine,
         o.required_qty::numeric AS required, LEAST(o.finished_qty, o.required_qty)::numeric AS finished,
         COALESCE(o.weight_kg, 0)::numeric AS weight_kg, o.due_date, o.shipping_status,
         CASE WHEN o.parent_id ~ '-[0-9]{4}$' THEN o.parent_id ELSE 'L-' || o.line_key END AS part_key,
         CASE WHEN o.parent_id ~ '-[0-9]{4}$' THEN regexp_replace(o.parent_id, '[0-9]{4}$', '') ELSE 'L-' || o.line_key END AS main_key,
         (o.parent_id IS NULL OR o.parent_id !~ '-[0-9]{4}$' OR o.parent_id ~ '-0000$') AS is_main
    FROM ai.order_lines o
   WHERE NOT o.is_cancelled AND NOT o.is_stock_line AND o.required_qty > 0
     AND ${where}
), qc AS (
  SELECT d.order_line_id,
         COALESCE(sum(d.pieces) FILTER (WHERE d.disposition = 'Rejected'), 0)::numeric AS rejected,
         COALESCE(sum(d.pieces) FILTER (WHERE d.disposition = 'Repair'), 0)::numeric AS repaired
    FROM ai.defects d JOIN line l ON l.order_line_id = d.order_line_id
   GROUP BY d.order_line_id
), made AS (
  SELECT r.order_line_id, max(r.work_day) AS last_day
    FROM ai.production_task_records r JOIN line l ON l.order_line_id = r.order_line_id
   WHERE r.produced_qty > 0
   GROUP BY r.order_line_id
), lines AS (
  SELECT l.*, COALESCE(q.rejected, 0) AS rejected, COALESCE(q.repaired, 0) AS repaired, m.last_day,
         GREATEST(l.required - l.finished, 0) AS remaining,
         (l.finished >= l.required) AS done,
         CASE WHEN l.finished >= l.required THEN GREATEST(m.last_day - l.due_date, 0)
              WHEN l.due_date < current_date THEN current_date - l.due_date END AS days_late
    FROM line l LEFT JOIN qc q ON q.order_line_id = l.order_line_id LEFT JOIN made m ON m.order_line_id = l.order_line_id
)`

/** A line's state against its due date, as a person reads it. */
const STATE = `CASE WHEN done AND (last_day IS NULL OR due_date IS NULL) THEN 'Done'
            WHEN done AND last_day <= due_date THEN 'Done on time'
            WHEN done THEN 'Done late'
            WHEN due_date < current_date THEN 'Overdue'
            ELSE 'In progress' END`

/** The dashboard's reject rate, in %: rejected ÷ (finished + rejected). */
const rejectRate = (rejected: string, finished: string) => `round((100.0 * ${rejected} / NULLIF(${finished} + ${rejected}, 0))::numeric, 2)`

/** Parts (a part = the rows of one Parent ID: one per machine it passes) and main items, from `lines`. */
const PARTS_AND_MAINS = `, parts AS (
  SELECT main_key, part_key, bool_or(is_main) AS is_main, max(item) AS item, max(item_code) AS item_code,
         string_agg(DISTINCT machine, ', ' ORDER BY machine) AS machines, max(order_number) AS order_number, max(customer) AS customer,
         max(required) AS required, min(finished) AS finished, max(weight_kg) AS weight_kg, max(due_date) AS due_date,
         max(shipping_status) AS shipping_status, sum(rejected) AS rejected, sum(repaired) AS repaired,
         bool_and(done) AS done, max(last_day) AS last_day
    FROM lines GROUP BY main_key, part_key
), mains AS (
  SELECT main_key, max(order_number) AS order_number, max(customer) AS customer,
         COALESCE(max(item) FILTER (WHERE is_main), max(item)) AS item,
         COALESCE(max(required) FILTER (WHERE is_main), max(required)) AS required,
         COALESCE(min(finished) FILTER (WHERE is_main), min(finished)) AS finished,
         sum(weight_kg) AS weight_kg, sum(weight_kg * LEAST(1, finished / NULLIF(required, 0))) AS finished_kg,
         max(due_date) AS due_date, max(shipping_status) FILTER (WHERE is_main) AS shipping_status,
         sum(rejected) AS rejected, sum(repaired) AS repaired, count(*) FILTER (WHERE NOT is_main) AS parts,
         bool_and(done) AS done, max(last_day) AS last_day
    FROM parts GROUP BY main_key
)`

const ORDER_INPUTS: AiReportInput[] = [
  { name: 'orders', label: 'Orders', kind: 'list', required: true, help: '20332 for the order and all its phases, 20332-Ph2.2 for one phase; several apart by commas' },
]

const ORDER_SECTIONS: AiReportSection[] = [
  {
    title: 'The orders at a glance',
    display: 'figures',
    sql: `${lineCtes(ORDERS_MATCH)}${PARTS_AND_MAINS}
SELECT string_agg(DISTINCT customer, ' · ') AS "Customer",
       count(*) AS "Main items",
       sum(required) AS "Pieces to make",
       sum(LEAST(finished, required)) AS "Pieces finished",
       round(100.0 * sum(LEAST(finished, required)) / NULLIF(sum(required), 0), 1) AS "Done %",
       round(sum(weight_kg) / 1000, 2) AS "Weight (t)",
       round(sum(finished_kg) / 1000, 2) AS "Finished weight (t)",
       sum(rejected) AS "Rejected pcs",
       sum(repaired) AS "Repaired pcs",
       ${rejectRate('sum(rejected)', 'sum(LEAST(finished, required))')} AS "Reject rate %",
       count(*) FILTER (WHERE NOT done AND due_date < current_date) AS "Main items overdue",
       max(due_date) AS "Latest due date"
  FROM mains`,
  },
  {
    title: 'Each order and phase',
    note: 'Main items only: an item made of parts counts once. Weight counts every part.',
    sql: `${lineCtes(ORDERS_MATCH)}${PARTS_AND_MAINS}
SELECT order_number AS "Order", max(customer) AS "Customer", max(due_date) AS "Due date",
       count(*) AS "Main items", sum(required) AS "To make", sum(LEAST(finished, required)) AS "Finished",
       sum(GREATEST(required - finished, 0)) AS "Remaining",
       round(100.0 * sum(LEAST(finished, required)) / NULLIF(sum(required), 0), 1) AS "Done %",
       round(sum(weight_kg) / 1000, 2) AS "Weight (t)", round(sum(finished_kg) / 1000, 2) AS "Finished (t)",
       count(*) FILTER (WHERE NOT done AND due_date < current_date) AS "Overdue",
       count(*) FILTER (WHERE shipping_status = 'Shipped') AS "Shipped",
       count(*) FILTER (WHERE shipping_status = 'Partial Shipped') AS "Partly shipped",
       count(*) FILTER (WHERE shipping_status IS NULL OR shipping_status NOT IN ('Shipped', 'Partial Shipped')) AS "Not shipped"
  FROM mains GROUP BY order_number ORDER BY order_number`,
    chart: { type: 'progress', x: 'Order', y: ['Finished', 'To make'], title: 'Each order: finished of what is to be made' },
  },
  {
    title: 'Main items, their parts and the machines each passed',
    display: 'tree',
    tree: { key: 'key', parent: 'parent' },
    note: 'Open a main item for its parts, and a part for each machine. An item is finished as far as the machine that has done the least of it.',
    sql: `${lineCtes(ORDERS_MATCH)}${PARTS_AND_MAINS}
SELECT key, parent, "Level", "Item", "Order", "Machine", "To make", "Finished", "Remaining", "Done %", "Weight kg", "Finished kg", "Due date",
       "Days overdue", "Shipping", "Rejected", "Repaired", "Reject %"
  FROM (
  SELECT 'M:' || m.main_key AS key, NULL::text AS parent, 'Main item' AS "Level", m.item AS "Item", m.order_number AS "Order", '' AS "Machine",
         m.required AS "To make", LEAST(m.finished, m.required) AS "Finished", GREATEST(m.required - m.finished, 0) AS "Remaining",
         round(100.0 * LEAST(m.finished, m.required) / NULLIF(m.required, 0), 1) AS "Done %",
         round(m.weight_kg, 1) AS "Weight kg", round(m.finished_kg, 1) AS "Finished kg", m.due_date AS "Due date",
         CASE WHEN m.done THEN NULL WHEN m.due_date < current_date THEN current_date - m.due_date END AS "Days overdue",
         COALESCE(m.shipping_status, '') AS "Shipping", m.rejected AS "Rejected", m.repaired AS "Repaired",
         ${rejectRate('m.rejected', 'LEAST(m.finished, m.required)')} AS "Reject %", 1 AS lvl, m.main_key AS sort_main, '' AS sort_part
    FROM mains m
  UNION ALL
  SELECT 'P:' || p.part_key, 'M:' || p.main_key, 'Part', p.item, p.order_number, p.machines,
         p.required, LEAST(p.finished, p.required), GREATEST(p.required - p.finished, 0),
         round(100.0 * LEAST(p.finished, p.required) / NULLIF(p.required, 0), 1),
         round(p.weight_kg, 1), round(p.weight_kg * LEAST(1, p.finished / NULLIF(p.required, 0)), 1), p.due_date,
         CASE WHEN p.done THEN NULL WHEN p.due_date < current_date THEN current_date - p.due_date END,
         COALESCE(p.shipping_status, ''), p.rejected, p.repaired, ${rejectRate('p.rejected', 'LEAST(p.finished, p.required)')}, 2, p.main_key, p.part_key
    FROM parts p WHERE NOT p.is_main
  UNION ALL
  SELECT 'L:' || l.line_key, CASE WHEN l.is_main THEN 'M:' || l.main_key ELSE 'P:' || l.part_key END, 'Machine', l.item, l.order_number, l.machine,
         l.required, l.finished, l.remaining, round(100.0 * l.finished / NULLIF(l.required, 0), 1),
         round(l.weight_kg, 1), round(l.weight_kg * l.finished / NULLIF(l.required, 0), 1), l.due_date, l.days_late,
         ${STATE}, l.rejected, l.repaired, ${rejectRate('l.rejected', 'l.finished')}, 3, l.main_key, CASE WHEN l.is_main THEN '' ELSE l.part_key END
    FROM lines l
) t ORDER BY sort_main, sort_part, lvl, "Machine"`,
  },
  {
    title: 'Each machine',
    note: 'Every line of the orders on each machine; the reject rate is rejected ÷ (finished + rejected), as on the dashboard.',
    sql: `${lineCtes(ORDERS_MATCH)}
SELECT machine AS "Machine", count(*) AS "Lines", sum(required) AS "To make", sum(finished) AS "Finished", sum(remaining) AS "Remaining",
       round(100.0 * sum(finished) / NULLIF(sum(required), 0), 1) AS "Done %",
       sum(rejected) AS "Rejected", sum(repaired) AS "Repaired",
       ${rejectRate('sum(rejected)', 'sum(finished)')} AS "Reject %",
       ${rejectRate('sum(repaired)', 'sum(finished)')} AS "Repaired %",
       count(*) FILTER (WHERE NOT done AND due_date < current_date) AS "Overdue lines"
  FROM lines GROUP BY machine ORDER BY sum(remaining) DESC, machine`,
    chart: { type: 'progress', x: 'Machine', y: ['Finished', 'To make'], title: 'Each machine: finished of what is to be made' },
  },
  {
    title: 'Where the pieces stand',
    note: 'From each order to the machines its lines are on (the 30 largest flows), and what each of those machines has finished or has still to make.',
    sql: `${lineCtes(ORDERS_MATCH)}
-- The largest flows from the orders to the machines (a chart reads 60 at most), then what those machines have done.
, flows AS (
  SELECT order_number AS "From", machine AS "To", sum(required) AS "Pieces" FROM lines GROUP BY order_number, machine
  ORDER BY sum(required) DESC LIMIT 30
)
SELECT * FROM (
  SELECT * FROM flows
  UNION ALL
  SELECT machine, 'Finished', sum(finished) FROM lines WHERE machine IN (SELECT "To" FROM flows) GROUP BY machine
  UNION ALL
  SELECT machine, 'Still to make', sum(remaining) FROM lines WHERE machine IN (SELECT "To" FROM flows) GROUP BY machine
) f WHERE "Pieces" > 0 ORDER BY "From", "To"`,
    chart: { type: 'sankey', x: 'From', y: ['Pieces'], series: 'To', title: 'From the orders to the machines' },
  },
  {
    title: 'Late and overdue',
    note: 'Lines past their due date and not finished, and lines finished after it (by the last day the production record shows work on them).',
    sql: `${lineCtes(ORDERS_MATCH)}
SELECT order_number AS "Order", item AS "Item", machine AS "Machine", required AS "To make", finished AS "Finished", remaining AS "Remaining",
       due_date AS "Due date", last_day AS "Last worked", days_late AS "Days late", ${STATE} AS "State"
  FROM lines WHERE days_late > 0
 ORDER BY done, days_late DESC, order_number, machine`,
  },
  {
    title: 'Pieces per hour against the standard',
    note: 'This order\'s pieces per hour on each item and machine (ERP production record, rows with actual hours) against ai_saved.standard_times, the last year\'s.',
    sql: `${lineCtes(ORDERS_MATCH)}, actual AS (
  SELECT l.item_code, r.work_center_code AS machine_code, max(l.machine) AS machine,
         sum(r.produced_qty) AS pieces, sum(r.actual_hours) AS hours
    FROM lines l JOIN ai.production_task_records r ON r.order_line_id = l.order_line_id
   WHERE r.produced_qty > 0 AND r.actual_hours > 0
   GROUP BY l.item_code, r.work_center_code
)
SELECT a.item_code || ' · ' || a.machine AS "Item on machine",
       s.pieces_per_hour AS "Standard pcs/h",
       round((a.pieces / NULLIF(a.hours, 0))::numeric, 2) AS "This order pcs/h",
       round((100.0 * (a.pieces / NULLIF(a.hours, 0)) / NULLIF(s.pieces_per_hour, 0))::numeric, 0) AS "% of standard",
       a.pieces AS "Pieces", round(a.hours::numeric, 1) AS "Hours"
  FROM actual a LEFT JOIN ai_saved.standard_times s ON s.item_code = a.item_code AND s.machine_code = a.machine_code
 WHERE s.pieces_per_hour IS NOT NULL
 ORDER BY a.hours DESC LIMIT 30`,
    chart: { type: 'dumbbell', x: 'Item on machine', y: ['Standard pcs/h', 'This order pcs/h'], title: 'Standard against this order' },
  },
]

// ---- Week tracking -------------------------------------------------------------------

const WEEK_INPUTS: AiReportInput[] = [
  { name: 'week', label: 'Planning week', kind: 'number', required: true, help: 'The week number of the order sheet\'s Pivot column', dynamicDefault: 'this_week' },
  { name: 'year', label: 'Year', kind: 'number', required: true, dynamicDefault: 'this_year' },
  { name: 'orders', label: 'Only these orders', kind: 'list', required: false, help: 'Leave empty for the whole week; 20332 takes all its phases' },
  { name: 'exclude', label: 'Leave out these orders', kind: 'list', required: false, help: '20332 leaves out all its phases, 20332-Ph2.2 one phase' },
]

const WEEK_MATCH = `o.planning_week_no = {{week}} AND o.planning_week_year = {{year}}
     AND ({{orders}} IS NULL OR ${ORDERS_MATCH})
     AND ({{exclude}} IS NULL OR NOT EXISTS (SELECT 1 FROM unnest({{exclude}}) AS x(v)
                WHERE lower(o.order_number) = lower(btrim(x.v))
                   OR left(lower(o.order_number), length(btrim(x.v)) + 1) = lower(btrim(x.v)) || '-'))`

const WEEK_SECTIONS: AiReportSection[] = [
  {
    title: 'The week at a glance',
    display: 'figures',
    sql: `${lineCtes(WEEK_MATCH)}
SELECT count(DISTINCT order_number) AS "Orders", count(*) AS "Lines", sum(required) AS "Pieces to make", sum(finished) AS "Pieces finished",
       sum(remaining) AS "Pieces remaining", round(100.0 * sum(finished) / NULLIF(sum(required), 0), 1) AS "Done %",
       round(sum(weight_kg) / 1000, 2) AS "Weight (t)", round(sum(weight_kg * finished / NULLIF(required, 0)) / 1000, 2) AS "Finished weight (t)",
       sum(rejected) AS "Rejected pcs", sum(repaired) AS "Repaired pcs", ${rejectRate('sum(rejected)', 'sum(finished)')} AS "Reject rate %",
       count(*) FILTER (WHERE done AND last_day <= due_date) AS "Done on time",
       count(*) FILTER (WHERE done AND last_day > due_date) AS "Done late",
       count(*) FILTER (WHERE NOT done AND due_date < current_date) AS "Overdue, not done"
  FROM lines`,
  },
  {
    title: 'Each machine',
    note: 'The weight of a line counts on every machine it passes; the week\'s total above counts it once a line.',
    sql: `${lineCtes(WEEK_MATCH)}
SELECT machine AS "Machine", count(*) AS "Lines", sum(required) AS "To make", sum(finished) AS "Finished", sum(remaining) AS "Remaining",
       round(100.0 * sum(finished) / NULLIF(sum(required), 0), 1) AS "Done %",
       round(sum(weight_kg) / 1000, 2) AS "Weight (t)", round(sum(weight_kg * finished / NULLIF(required, 0)) / 1000, 2) AS "Finished (t)",
       sum(rejected) AS "Rejected", sum(repaired) AS "Repaired", ${rejectRate('sum(rejected)', 'sum(finished)')} AS "Reject %",
       count(*) FILTER (WHERE done AND last_day <= due_date) AS "On time",
       count(*) FILTER (WHERE done AND last_day > due_date) AS "Late",
       count(*) FILTER (WHERE NOT done AND due_date < current_date) AS "Overdue"
  FROM lines GROUP BY machine ORDER BY sum(remaining) DESC, machine`,
    chart: { type: 'progress', x: 'Machine', y: ['Finished', 'To make'], title: 'Each machine this week' },
  },
  {
    title: 'Each order',
    sql: `${lineCtes(WEEK_MATCH)}
SELECT order_number AS "Order", max(customer) AS "Customer", max(due_date) AS "Due date", count(*) AS "Lines",
       sum(required) AS "To make", sum(finished) AS "Finished", sum(remaining) AS "Remaining",
       round(100.0 * sum(finished) / NULLIF(sum(required), 0), 1) AS "Done %", round(sum(weight_kg) / 1000, 2) AS "Weight (t)",
       count(*) FILTER (WHERE NOT done AND due_date < current_date) AS "Overdue lines"
  FROM lines GROUP BY order_number ORDER BY sum(remaining) DESC, order_number`,
  },
  {
    title: 'What is missing, and where',
    note: 'Every line not finished: its order, its item, the machine it waits on, and how far past its due date it is.',
    sql: `${lineCtes(WEEK_MATCH)}
SELECT machine AS "Machine", order_number AS "Order", item_code AS "Item code", item AS "Item", required AS "To make", finished AS "Finished", remaining AS "Remaining",
       due_date AS "Due date", days_late AS "Days overdue", ${STATE} AS "State"
  FROM lines WHERE NOT done
 ORDER BY machine, days_late DESC NULLS LAST, order_number`,
  },
]

// ---- Making them --------------------------------------------------------------------

interface StarterReport {
  key: string
  title: string
  description: string
  inputs: AiReportInput[]
  sections: AiReportSection[]
}

export const STARTER_REPORTS: readonly StarterReport[] = [
  {
    key: 'order-tracking',
    title: 'Order tracking',
    description:
      'One order or several, an order number standing for all its phases (20332), or one phase alone (20332-Ph2.2): the customer, the pieces to make and finished, the weight, the rejects, each order and phase, the main items with their parts and the machines each passed, each machine, what is late, where the pieces stand, and the pieces per hour against the standard (saved table standard_times). ' +
      'An item passing several machines is finished as far as the machine that has done the least of it; a main item made of parts counts its main row, its weight is the sum of its parts. The reject rate is the dashboard\'s: rejected ÷ (finished + rejected), from the inspection record. Cancelled lines are left out. Shipping shows the order sheet\'s status (it holds no shipped quantity).',
    inputs: ORDER_INPUTS,
    sections: ORDER_SECTIONS,
  },
  {
    key: 'week-tracking',
    title: 'Week tracking',
    description:
      'A planning week of the order sheet (its Pivot column), all of it or only some orders, with orders to leave out: the lines of the week, what each machine had to make, has finished and has left, the weight, the rejects and repairs, the lines finished on time or late (by the last day the production record shows work on them) and those overdue, each order, and every line still missing, on which machine. ' +
      'Every line counts (not only main items). The reject rate is the dashboard\'s: rejected ÷ (finished + rejected), from the inspection record. Cancelled lines are left out.',
    inputs: WEEK_INPUTS,
    sections: WEEK_SECTIONS,
  },
]

export interface StarterDeps {
  db: Db
  config: Config
  readers: SavedTableReaders
}

/**
 * Make what the assistant starts with that is not made yet, as its owner's. Nothing without an owner whose access
 * is on, or before the data's reader is ready: the next start tries again. A table that cannot be computed yet (no
 * production record) is tried again on the next start; the reports are made either way.
 */
export async function ensureStarters(deps: StarterDeps): Promise<{ reports: string[]; table: 'made' | 'there' | string }> {
  const made: string[] = []
  const ownerId = await currentAiOwner(deps.db, deps.config)
  if (!ownerId || !deps.readers.ready) return { reports: made, table: 'no owner or reader yet' }
  const owner = await deps.db.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [ownerId])
  const access = await loadAccess(deps.db, ownerId)
  let table: 'made' | 'there' | string = 'there'
  const existing = await deps.db.query(`SELECT 1 FROM ai_saved_tables WHERE name = $1`, [STANDARD_TIMES_TABLE])
  if (!existing.rowCount) {
    const saved = await saveTable(
      { db: deps.db, readers: deps.readers, timeZone: deps.config.FACTORY_TIMEZONE },
      { id: ownerId, name: owner.rows[0]?.name ?? 'Owner', owner: true, domains: access?.domains ?? [] },
      {
        name: STANDARD_TIMES_TABLE,
        title: 'Standard times: pieces per hour of each item on each machine',
        summary: 'How many pieces of each item each machine makes in an hour, from the last year of the production record: the standard each order is compared against.',
        description:
          'One row per item code and machine: the pieces made and the hours they took over the last 365 days of the ERP production record (ai.production_task_records), counting only rows with both pieces and actual hours, and only item–machine pairs with at least 3 such rows. pieces_per_hour = pieces ÷ hours; minutes_per_piece = 60 × hours ÷ pieces; kg_per_hour from the produced weight. Computed again every night.',
        source: 'query',
        sql: STANDARD_TIMES_SQL,
        refresh: 'daily',
        notes: {
          item_code: 'The order sheet\'s item code (Item ID) of the lines worked.',
          machine_code: 'The machine (work center) code.',
          records: 'Production rows counted.',
          pieces_per_hour: 'Pieces made per actual hour: the standard.',
          minutes_per_piece: 'Minutes one piece takes.',
        },
      },
    )
    table = saved.ok ? 'made' : saved.error
  }
  for (const r of STARTER_REPORTS) {
    const there = await deps.db.query(`SELECT 1 FROM ai_reports WHERE starter_key = $1`, [r.key])
    if (there.rowCount) continue
    await insertReport(deps.db, {
      userId: ownerId,
      conversationId: null,
      turnId: null,
      title: r.title,
      question: r.title,
      description: r.description,
      period: null,
      adjustable: false,
      sections: r.sections,
      inputs: r.inputs,
      shared: true,
      madeBy: 'starter',
      starterKey: r.key,
      // The app's own queries: a schedule that sends it reads as its creator may.
      authorDomains: null,
    })
    made.push(r.key)
  }
  return { reports: made, table }
}
