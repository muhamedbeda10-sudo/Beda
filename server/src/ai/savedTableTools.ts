// ============================================================================
// The saved tables in the AI assistant: four tools of a new conversation
// (loaded only when a question needs them, through the tool search) and the
// card a change leaves.
//
//   list_saved_tables     the tables this person may read, or one in full
//   save_table            make or replace one, computed at once
//   refresh_saved_table   compute one again now
//   remove_saved_table    remove one
//
// A change is made at once and shown as a card; the Saved tables page lists
// them all. Each call reads the person's access again: their domains decide
// what a table may read, and only someone still given the assistant may
// change one.
// ============================================================================

import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { AiStreamEvent } from '@qc/shared/ai'
import {
  SAVED_TABLE_COLUMN_TYPES,
  SAVED_TABLE_DESCRIPTION_MAX,
  SAVED_TABLE_MAX_LITERAL_ROWS,
  SAVED_TABLE_MAX_ROWS,
  SAVED_TABLE_NOTE_MAX,
  SAVED_TABLE_REFRESHES,
  SAVED_TABLE_SUMMARY_MAX,
  SAVED_TABLE_TITLE_MAX,
  type AiSavedTablePart,
  type SavedTable,
} from '@qc/shared/savedTables'
import type { Config } from '../config'
import type { Db } from '../db/pool'
import { describeIssues } from '../automations/draft'
import type { ToolHandler, ToolOutcome } from './assistant'
import { isGranted, loadAccess } from './access'
import { isAiOwner } from './owner'
import { AI_MAX_SQL_CHARS } from './runQuery'
import {
  findSavedTable,
  listSavedTables,
  refreshTable,
  removeTable,
  saveTable,
  type SavedTableActor,
  type SavedTableDefinition,
  type SavedTableOutcome,
  type SavedTableReaders,
} from './savedTables'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const LIST_SAVED_TABLES_TOOL_NAME = 'list_saved_tables'
export const SAVE_TABLE_TOOL_NAME = 'save_table'
export const REFRESH_SAVED_TABLE_TOOL_NAME = 'refresh_saved_table'
export const REMOVE_SAVED_TABLE_TOOL_NAME = 'remove_saved_table'

const NAME_PROPERTY = { type: 'string', description: 'The table\'s name, as in ai_saved.<name>.' }

export const LIST_SAVED_TABLES_TOOL: Anthropic.Beta.BetaTool = {
  name: LIST_SAVED_TABLES_TOOL_NAME,
  description:
    'List the saved tables this person may read (ai_saved.<name>): what each holds, its columns, how it is computed and how often, when it was last computed and how many rows it has, whether its last computation failed, and who made it. ' +
    'With name, that one table in full, its query included. Look here before you build a table, to use or extend one that exists rather than make it twice.',
  input_schema: { type: 'object', properties: { name: NAME_PROPERTY }, additionalProperties: false },
}

export const SAVE_TABLE_TOOL: Anthropic.Beta.BetaTool = {
  name: SAVE_TABLE_TOOL_NAME,
  description:
    'Save a table to build on: the result of a query over the ai.* views and other saved tables, stored and computed again by the database on a schedule (source query), or rows you write out, such as a mapping or a list of targets (source rows). ' +
    'It is computed at once and read afterwards like a view, as ai_saved.<name>, in questions, reports and automations; anyone who may read everything its query reads may read it. ' +
    `A query's table holds at most ${SAVED_TABLE_MAX_ROWS.toLocaleString('en-US')} rows; rows written out at most ${SAVED_TABLE_MAX_LITERAL_ROWS.toLocaleString('en-US')}. ` +
    'Returns what was saved (its columns, its row count and who may read it), or why nothing was. The person sees it as a card.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Lowercase letters, digits and _, starting with a letter, 2 to 48 characters, saying what a row is: routing_steps, scrap_normal_range.' },
      title: { type: 'string', description: `What the table is, in a few words, in the person's language (at most ${SAVED_TABLE_TITLE_MAX} characters).` },
      summary: {
        type: 'string',
        description: `What the table shows, in one or two short, plain sentences in the person's language, for someone on the floor who reads neither SQL nor column names: no view, column or rule names (at most ${SAVED_TABLE_SUMMARY_MAX} characters). It leads the table on the Saved tables page; the description stays under Details.`,
      },
      description: {
        type: 'string',
        description: `What one row is, where the rows come from (the data and the period, the rules applied) and what the table is for, written to be read later on its own (at most ${SAVED_TABLE_DESCRIPTION_MAX} characters).`,
      },
      source: { type: 'string', enum: ['query', 'rows'] },
      sql: { type: 'string', description: 'For source query: ONE read-only SELECT (or WITH ... SELECT) over ai.* views and ai_saved.* tables, as run_sql takes it, returning every row the table should hold (no LIMIT). Alias every column with a lowercase name.' },
      refresh: {
        type: 'string',
        enum: [...SAVED_TABLE_REFRESHES],
        description: 'For source query: never (kept as computed now: a baseline that must not move), hourly, or daily (every night). Choose what keeps it as fresh as its use needs: daily for most, hourly when an automation watches recent work against it.',
      },
      columnNotes: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: `For source query: what a column holds, by column name, when its name does not say it all (units, how it is computed); at most ${SAVED_TABLE_NOTE_MAX} characters each.`,
      },
      columns: {
        type: 'array',
        description: 'For source rows: the columns, in order.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: [...SAVED_TABLE_COLUMN_TYPES] },
            note: { type: 'string', description: 'What the column holds, when its name does not say it all.' },
          },
          required: ['name', 'type'],
          additionalProperties: false,
        },
      },
      rows: {
        type: 'array',
        description: 'For source rows: the rows, each an array of values in the order of columns (null for none). Dates as YYYY-MM-DD.',
        items: { type: 'array', items: {} },
      },
      replace: { type: 'boolean', description: 'true to replace the table of this name (one this person made, or any for the assistant\'s owner); otherwise a name already used is refused.' },
    },
    required: ['name', 'title', 'summary', 'description', 'source'],
    additionalProperties: false,
  },
}

export const REFRESH_SAVED_TABLE_TOOL: Anthropic.Beta.BetaTool = {
  name: REFRESH_SAVED_TABLE_TOOL_NAME,
  description: 'Compute a saved table again now, from its query, when its rows must be up to the minute (new data was imported since it was last computed). Returns its row count as computed, or why it could not be.',
  input_schema: { type: 'object', properties: { name: NAME_PROPERTY }, required: ['name'], additionalProperties: false },
}

export const REMOVE_SAVED_TABLE_TOOL: Anthropic.Beta.BetaTool = {
  name: REMOVE_SAVED_TABLE_TOOL_NAME,
  description:
    'Remove a saved table, only when the person asks for it: whoever made it, or the assistant\'s owner, may. A table other saved tables are built on cannot be removed until they are. Automations or reports that read it fail from then on: check my_automations first when the person has any.',
  input_schema: { type: 'object', properties: { name: NAME_PROPERTY }, required: ['name'], additionalProperties: false },
}

export const SAVED_TABLE_TOOLS: readonly Anthropic.Beta.BetaTool[] = [LIST_SAVED_TABLES_TOOL, SAVE_TABLE_TOOL, REFRESH_SAVED_TABLE_TOOL, REMOVE_SAVED_TABLE_TOOL]

const NameInput = z.object({ name: z.string().trim().min(1).max(64) }).passthrough()
const ListInput = z.object({ name: z.string().trim().min(1).max(64).nullish() }).passthrough()
const SaveInput = z
  .object({
    name: z.string().trim(),
    title: z.string().trim().min(1).max(SAVED_TABLE_TITLE_MAX),
    summary: z.string().trim().max(SAVED_TABLE_SUMMARY_MAX).default(''),
    description: z.string().trim().max(SAVED_TABLE_DESCRIPTION_MAX).default(''),
    source: z.enum(['query', 'rows']),
    sql: z.string().max(AI_MAX_SQL_CHARS).nullish(),
    refresh: z.enum(['never', 'hourly', 'daily']).nullish(),
    columnNotes: z.record(z.string().max(SAVED_TABLE_NOTE_MAX * 2)).nullish(),
    columns: z
      .array(z.object({ name: z.string().trim(), type: z.enum(['text', 'number', 'integer', 'date', 'timestamp', 'boolean']), note: z.string().max(SAVED_TABLE_NOTE_MAX * 2).nullish() }))
      .nullish(),
    rows: z.array(z.array(z.unknown())).nullish(),
    replace: z.boolean().nullish(),
  })
  .passthrough()

export interface SavedTableToolContext {
  db: Db
  config: Config
  readers: SavedTableReaders
  userId: string
  userName: string
  conversationId: string
  turnId: string
  emit: (event: AiStreamEvent) => void
}

const failed = (tu: ToolUse, content: string): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, is_error: true, content } })
const answered = (tu: ToolUse, content: unknown): ToolOutcome => ({ result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) } })

export function savedTableToolHandlers(ctx: SavedTableToolContext): Record<string, ToolHandler> {
  return {
    [LIST_SAVED_TABLES_TOOL_NAME]: { run: (tu) => list(ctx, tu) },
    [SAVE_TABLE_TOOL_NAME]: { run: (tu) => save(ctx, tu) },
    [REFRESH_SAVED_TABLE_TOOL_NAME]: { run: (tu) => refresh(ctx, tu) },
    [REMOVE_SAVED_TABLE_TOOL_NAME]: { run: (tu) => remove(ctx, tu) },
  }
}

/** The person as they stand now; null when the assistant is no longer theirs. */
async function actorOf(ctx: SavedTableToolContext): Promise<SavedTableActor | null> {
  const access = await loadAccess(ctx.db, ctx.userId)
  if (!isGranted(access)) return null
  return { id: ctx.userId, name: ctx.userName, owner: await isAiOwner(ctx.db, ctx.config, ctx.userId), domains: access.domains }
}

const NOT_GRANTED = 'The person asking no longer has access to the assistant.'

/** A table as the model reads it in a list: without its query, unless asked for one. */
function described(t: SavedTable, full: boolean) {
  return {
    name: `ai_saved.${t.name}`,
    title: t.title,
    summary: t.summary,
    description: t.description,
    source: t.source,
    ...(full && t.sql ? { sql: t.sql } : {}),
    refresh: t.source === 'query' ? t.refresh : 'rows written out',
    columns: t.columns.map((c) => (c.note ? `${c.name} ${c.type}: ${c.note}` : `${c.name} ${c.type}`)),
    rowCount: t.rowCount,
    refreshedAt: t.refreshedAt,
    ...(t.nextRefreshAt ? { nextRefreshAt: t.nextRefreshAt } : {}),
    ...(t.lastError ? { lastError: t.lastError, lastErrorAt: t.lastErrorAt } : {}),
    readableBy: readers(t),
    dependsOn: t.dependsOn,
    madeBy: t.createdByName,
    mayChange: t.mayRemove,
  }
}

const readers = (t: Pick<SavedTable, 'domains'>) => (t.domains.length === 0 ? 'everyone given the assistant' : `people who may read: ${t.domains.join(', ')}`)

async function list(ctx: SavedTableToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const parsed = ListInput.safeParse(tu.input ?? {})
  if (!parsed.success) return failed(tu, describeIssues(parsed.error).join('\n'))
  const actor = await actorOf(ctx)
  if (!actor) return failed(tu, NOT_GRANTED)
  const name = bareName(parsed.data.name)
  if (name) {
    const table = await findSavedTable(ctx.db, actor, { name })
    return table ? answered(tu, described(table, true)) : failed(tu, `There is no saved table named ${name} that this person may read.`)
  }
  const tables = await listSavedTables(ctx.db, actor)
  return answered(tu, { tables: tables.map((t) => described(t, false)), ...(tables.length === 0 ? { note: 'No saved tables yet.' } : {}) })
}

/** A name as the model may write it: ai_saved.x, or quoted. */
const bareName = (name: string | null | undefined) => (name ? name.trim().replace(/^ai_saved\s*\.\s*/i, '').replace(/^"(.*)"$/, '$1').toLowerCase() : null)

async function save(ctx: SavedTableToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const parsed = SaveInput.safeParse(tu.input ?? {})
  if (!parsed.success) return failed(tu, ['Nothing was saved. Fix these and call save_table again:', ...describeIssues(parsed.error).map((p) => `- ${p}`)].join('\n'))
  const i = parsed.data
  const problems: string[] = []
  if (i.source === 'query') {
    if (!i.sql?.trim()) problems.push('sql: the SELECT the table is computed from.')
    if (!i.refresh) problems.push('refresh: never, hourly or daily.')
    if (i.columns || i.rows) problems.push('columns and rows: only for source rows; leave them out.')
  } else {
    if (!i.columns?.length) problems.push('columns: the columns, in order.')
    if (!i.rows) problems.push('rows: the rows (an empty list for none yet).')
    if (i.sql) problems.push('sql: only for source query; leave it out.')
  }
  if (problems.length > 0) return failed(tu, ['Nothing was saved. Fix these and call save_table again:', ...problems.map((p) => `- ${p}`)].join('\n'))
  const actor = await actorOf(ctx)
  if (!actor) return failed(tu, NOT_GRANTED)
  const name = bareName(i.name) ?? ''
  const base = { name, title: i.title, summary: i.summary, description: i.description }
  const def: SavedTableDefinition =
    i.source === 'query'
      ? { ...base, source: 'query', sql: i.sql!, refresh: i.refresh!, notes: i.columnNotes ?? {} }
      : { ...base, source: 'rows', columns: i.columns!.map((c) => ({ name: c.name, type: c.type, note: c.note ?? undefined })), rows: i.rows! }
  const outcome = await saveTable({ db: ctx.db, readers: ctx.readers, timeZone: ctx.config.FACTORY_TIMEZONE }, actor, def, !!i.replace, origin(ctx, tu))
  if (!outcome.ok) return failed(tu, outcome.error)
  const t = outcome.table
  emitCard(ctx, outcome, t.version > 1 ? 'replace' : 'create')
  return answered(tu, {
    saved: true,
    ...described(t, false),
    note:
      `Saved as ai_saved.${t.name} with ${t.rowCount ?? 0} rows; read it with run_sql like a view. ` +
      (t.refresh === 'never' ? 'It is kept as computed now. ' : `It is computed again ${t.refresh === 'hourly' ? 'every hour' : 'every night'}. `) +
      'Check a few rows and the totals before you rely on it. The person sees it as a card; tell them in a sentence what it holds and what it is for.',
  })
}

async function refresh(ctx: SavedTableToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const parsed = NameInput.safeParse(tu.input ?? {})
  if (!parsed.success) return failed(tu, describeIssues(parsed.error).join('\n'))
  const actor = await actorOf(ctx)
  if (!actor) return failed(tu, NOT_GRANTED)
  const name = bareName(parsed.data.name)!
  const table = await findSavedTable(ctx.db, actor, { name })
  if (!table) return failed(tu, `There is no saved table named ${name} that this person may read.`)
  const outcome = await refreshTable({ db: ctx.db, readers: ctx.readers, timeZone: ctx.config.FACTORY_TIMEZONE }, table.id, { id: actor.id, name: actor.name }, origin(ctx, tu))
  if (!outcome.ok) return failed(tu, outcome.error)
  emitCard(ctx, outcome, 'refresh')
  return answered(tu, { computed: true, name: `ai_saved.${name}`, rowCount: outcome.table.rowCount, refreshedAt: outcome.table.refreshedAt })
}

async function remove(ctx: SavedTableToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const parsed = NameInput.safeParse(tu.input ?? {})
  if (!parsed.success) return failed(tu, describeIssues(parsed.error).join('\n'))
  const actor = await actorOf(ctx)
  if (!actor) return failed(tu, NOT_GRANTED)
  const name = bareName(parsed.data.name)!
  const table = await findSavedTable(ctx.db, actor, { name })
  if (!table) return failed(tu, `There is no saved table named ${name} that this person may read.`)
  const outcome = await removeTable({ db: ctx.db, readers: ctx.readers, timeZone: ctx.config.FACTORY_TIMEZONE }, actor, table.id, origin(ctx, tu))
  if (!outcome.ok) return failed(tu, outcome.error)
  emitCard(ctx, outcome, 'remove')
  return answered(tu, { removed: true, name: `ai_saved.${name}`, note: 'Removed: queries, reports and automations that read it fail from now on. The person sees it as a card.' })
}

const origin = (ctx: SavedTableToolContext, tu: ToolUse) => ({ conversationId: ctx.conversationId, turnId: ctx.turnId, toolUseId: tu.id })

function emitCard(ctx: SavedTableToolContext, outcome: Extract<SavedTableOutcome, { ok: true }>, action: AiSavedTablePart['action']): void {
  const t = outcome.table
  ctx.emit({
    type: 'saved-table',
    part: {
      type: 'saved-table',
      changeId: outcome.changeId,
      tableId: t.id,
      name: t.name,
      title: t.title,
      action,
      source: t.source,
      refresh: t.refresh,
      rowCount: t.rowCount,
      columns: t.columns.map((c) => c.name),
      state: action === 'remove' ? 'removed' : 'current',
    },
  })
}
