// ============================================================================
// The saved tables in the AI assistant: four tools of a new conversation
// (loaded only when a question needs them, through the tool search) and the
// card a change leaves.
//
//   list_saved_tables     the tables this person may read, or one in full
//   save_table            make or replace one, computed at once
//   update_saved_table    change one in place: its words, notes or schedule
//                         at once; its query or rows, computed again
//   refresh_saved_table   compute one again now
//   remove_saved_table    remove one
//
// A change is made at once and shown as a card; the Saved tables page lists
// them all. Each call reads the person's access again: their domains decide
// what a table may read, and only someone still given the assistant may
// change one. A table someone else made (the owner may change anyone's) is
// replaced, changed or removed only at the person's own word: the call quotes
// their words asking for it from their message of this question
// (confirmation, automations/confirmation.ts), so nothing the assistant
// reads can change other people's tables. Rows written out are read only by
// those who may read everything the conversation's queries read
// (savedTables.ts, conversationDomains): they may have been copied from it.
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
import { loadSavedTableParts } from './savedTableParts'
import { describeIssues } from '../automations/draft'
import type { ToolHandler, ToolOutcome } from './assistant'
import { isGranted, loadAccess } from './access'
import { isAiOwner } from './owner'
import { AI_MAX_SQL_CHARS } from './runQuery'
import { personsOwnWords } from '../automations/confirmation'
import {
  conversationDomains,
  findSavedTable,
  listSavedTables,
  refreshTable,
  removeTable,
  saveTable,
  tableMaker,
  updateTable,
  type SavedTableActor,
  type SavedTableChanges,
  type SavedTableDefinition,
  type SavedTableOutcome,
  type SavedTableReaders,
} from './savedTables'

type ToolUse = Anthropic.Beta.BetaToolUseBlock

export const LIST_SAVED_TABLES_TOOL_NAME = 'list_saved_tables'
export const SAVE_TABLE_TOOL_NAME = 'save_table'
export const UPDATE_SAVED_TABLE_TOOL_NAME = 'update_saved_table'
export const REFRESH_SAVED_TABLE_TOOL_NAME = 'refresh_saved_table'
export const REMOVE_SAVED_TABLE_TOOL_NAME = 'remove_saved_table'

const NAME_PROPERTY = { type: 'string', description: 'The table\'s name, as in ai_saved.<name>.' }
const CONFIRMATION_PROPERTY = {
  type: 'string',
  description:
    "Only for a table someone else made (madeBy in list_saved_tables): the person's own words in their latest message asking for this, copied exactly as they wrote them. Leave it out for a table this person made.",
}

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
    'It is computed at once and read afterwards like a view, as ai_saved.<name>, in questions, reports and automations; anyone who may read everything its query reads may read it (rows written out: everything the queries of this conversation read, which they may have been copied from). ' +
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
      replace: {
        type: 'boolean',
        description:
          'true to replace the table of this name with a whole new definition (one this person made, or any for the assistant\'s owner); otherwise a name already used is refused. To change part of a table — its words, notes, schedule, query or rows — use update_saved_table instead.',
      },
      confirmation: { ...CONFIRMATION_PROPERTY, description: `With replace, ${CONFIRMATION_PROPERTY.description}` },
    },
    required: ['name', 'title', 'summary', 'description', 'source'],
    additionalProperties: false,
  },
}

export const UPDATE_SAVED_TABLE_TOOL: Anthropic.Beta.BetaTool = {
  name: UPDATE_SAVED_TABLE_TOOL_NAME,
  description:
    'Change a saved table in place, keeping its name (whatever reads ai_saved.<name> goes on reading it) and its history: give only what changes. ' +
    'title, summary, description, columnNotes and refresh change at once; its rows stay as they are. ' +
    'A new sql (a query\'s table), or new rows, rows added or new columns (rows written out), compute it again now and are checked like save_table. ' +
    'The name itself never changes: to give a table another name, save a new one and remove the old one when nothing reads it. ' +
    'Whoever made the table, or the assistant\'s owner, may change it. Returns the table as it is now, or why nothing changed. The person sees it as a card.',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      name: NAME_PROPERTY,
      title: { type: 'string', description: `A new title, in the person's language (at most ${SAVED_TABLE_TITLE_MAX} characters).` },
      summary: { type: 'string', description: `A new summary: one or two plain sentences for the person, no SQL or column names (at most ${SAVED_TABLE_SUMMARY_MAX} characters).` },
      description: { type: 'string', description: `A new description, in full: what one row is, where the rows come from, the rules applied (at most ${SAVED_TABLE_DESCRIPTION_MAX} characters).` },
      columnNotes: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: `Notes by column name, merged into the table's: an empty one removes that column's note (at most ${SAVED_TABLE_NOTE_MAX} characters each).`,
      },
      refresh: { type: 'string', enum: [...SAVED_TABLE_REFRESHES], description: 'For a query\'s table: never, hourly or daily (every night).' },
      sql: { type: 'string', description: 'For a query\'s table: the new SELECT, whole, as save_table takes it. Computed at once.' },
      columns: {
        type: 'array',
        description: 'For rows written out: the new columns, in order; give rows with them.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: [...SAVED_TABLE_COLUMN_TYPES] },
            note: { type: 'string' },
          },
          required: ['name', 'type'],
          additionalProperties: false,
        },
      },
      rows: { type: 'array', description: 'For rows written out: every row, in place of the table\'s (each an array in the order of the columns).', items: { type: 'array', items: {} } },
      addRows: { type: 'array', description: 'For rows written out: rows to add after the table\'s.', items: { type: 'array', items: {} } },
      confirmation: CONFIRMATION_PROPERTY,
    },
    required: ['name'],
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
  input_schema: { type: 'object', properties: { name: NAME_PROPERTY, confirmation: CONFIRMATION_PROPERTY }, required: ['name'], additionalProperties: false },
}

export const SAVED_TABLE_TOOLS: readonly Anthropic.Beta.BetaTool[] = [LIST_SAVED_TABLES_TOOL, SAVE_TABLE_TOOL, UPDATE_SAVED_TABLE_TOOL, REFRESH_SAVED_TABLE_TOOL, REMOVE_SAVED_TABLE_TOOL]

const NameInput = z.object({ name: z.string().trim().min(1).max(64), confirmation: z.string().nullish() }).passthrough()
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
    confirmation: z.string().nullish(),
  })
  .passthrough()

const LiteralColumnInput = z.object({ name: z.string().trim(), type: z.enum(['text', 'number', 'integer', 'date', 'timestamp', 'boolean']), note: z.string().max(SAVED_TABLE_NOTE_MAX * 2).nullish() })
const UpdateInput = z
  .object({
    name: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(SAVED_TABLE_TITLE_MAX).nullish(),
    summary: z.string().trim().max(SAVED_TABLE_SUMMARY_MAX).nullish(),
    description: z.string().trim().max(SAVED_TABLE_DESCRIPTION_MAX).nullish(),
    columnNotes: z.record(z.string().max(SAVED_TABLE_NOTE_MAX * 2)).nullish(),
    refresh: z.enum(['never', 'hourly', 'daily']).nullish(),
    sql: z.string().max(AI_MAX_SQL_CHARS).nullish(),
    columns: z.array(LiteralColumnInput).nullish(),
    rows: z.array(z.array(z.unknown())).nullish(),
    addRows: z.array(z.array(z.unknown())).nullish(),
    confirmation: z.string().nullish(),
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
    [SAVE_TABLE_TOOL_NAME]: { run: (tu) => once(ctx, tu, save) },
    [UPDATE_SAVED_TABLE_TOOL_NAME]: { run: (tu) => once(ctx, tu, update) },
    [REFRESH_SAVED_TABLE_TOOL_NAME]: { run: (tu) => once(ctx, tu, refresh) },
    [REMOVE_SAVED_TABLE_TOOL_NAME]: { run: (tu) => once(ctx, tu, remove) },
  }
}

/** A step finished after the answer was cut short runs its calls again: a change already made is not made twice. */
async function once(ctx: SavedTableToolContext, tu: ToolUse, run: (ctx: SavedTableToolContext, tu: ToolUse) => Promise<ToolOutcome>): Promise<ToolOutcome> {
  const made = (await loadSavedTableParts(ctx.db, ctx.conversationId, ctx.turnId)).get(tu.id)
  if (!made) return run(ctx, tu)
  const done = tu.name === UPDATE_SAVED_TABLE_TOOL_NAME ? 'changed' : made.action === 'remove' ? 'removed' : made.action === 'refresh' ? 'computed' : 'saved'
  const content = { [done]: true, name: `ai_saved.${made.name}`, rowCount: made.rowCount, note: 'Done before the answer was interrupted; the person sees it as a card.' }
  return { result: { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(content) } }
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
  if (i.replace) {
    const refusal = await othersTable(ctx, actor, { name }, i.confirmation, `Replacing the saved table ${name}, made by someone else,`, SAVE_TABLE_TOOL_NAME)
    if (refusal) return failed(tu, refusal)
  }
  const base = { name, title: i.title, summary: i.summary, description: i.description }
  let def: SavedTableDefinition
  if (i.source === 'query') def = { ...base, source: 'query', sql: i.sql!, refresh: i.refresh!, notes: i.columnNotes ?? {} }
  else {
    // The rows may be copied from anything the conversation read: they are read as that is.
    const read = await conversationDomains(deps(ctx), ctx.conversationId, actor)
    if ('error' in read) return failed(tu, `Nothing was saved: ${read.error}`)
    def = { ...base, source: 'rows', columns: i.columns!.map((c) => ({ name: c.name, type: c.type, note: c.note ?? undefined })), rows: i.rows!, domains: read.domains }
  }
  const outcome = await saveTable(deps(ctx), actor, def, !!i.replace, origin(ctx, tu))
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

async function update(ctx: SavedTableToolContext, tu: ToolUse): Promise<ToolOutcome> {
  const parsed = UpdateInput.safeParse(tu.input ?? {})
  if (!parsed.success) return failed(tu, ['Nothing was changed. Fix these and call update_saved_table again:', ...describeIssues(parsed.error).map((p) => `- ${p}`)].join('\n'))
  const i = parsed.data
  const actor = await actorOf(ctx)
  if (!actor) return failed(tu, NOT_GRANTED)
  const name = bareName(i.name)!
  const table = await findSavedTable(ctx.db, actor, { name })
  if (!table) return failed(tu, `There is no saved table named ${name} that this person may read.`)
  const refusal = await othersTable(ctx, actor, { id: table.id }, i.confirmation, `Changing the saved table ${name}, made by ${table.createdByName},`, UPDATE_SAVED_TABLE_TOOL_NAME)
  if (refusal) return failed(tu, refusal)
  const given = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)
  const changes: SavedTableChanges = {
    title: given(i.title),
    summary: given(i.summary),
    description: given(i.description),
    columnNotes: given(i.columnNotes),
    refresh: given(i.refresh),
    sql: given(i.sql),
    columns: i.columns ? i.columns.map((c) => ({ name: c.name, type: c.type, note: c.note ?? undefined })) : undefined,
    rows: given(i.rows),
    addRows: given(i.addRows),
  }
  if (table.source === 'rows' && (changes.rows || changes.addRows || changes.columns)) {
    // New rows may be copied from anything the conversation read: the table is read as that is too.
    const read = await conversationDomains(deps(ctx), ctx.conversationId, actor)
    if ('error' in read) return failed(tu, `Nothing was changed: ${read.error}`)
    changes.readFrom = read.domains
  }
  const outcome = await updateTable(deps(ctx), actor, table.id, changes, origin(ctx, tu))
  if (!outcome.ok) return failed(tu, `Nothing was changed: ${outcome.error}`)
  emitCard(ctx, outcome, outcome.dataChanged ? 'replace' : 'update')
  const t = outcome.table
  return answered(tu, {
    changed: true,
    computedAgain: !!outcome.dataChanged,
    ...described(t, false),
    note: outcome.dataChanged
      ? `Computed again as ai_saved.${t.name}: ${t.rowCount ?? 0} rows. Check a few rows and the totals before you rely on it. The person sees it as a card; tell them in a sentence what changed.`
      : 'Changed in place; its rows are as they were. The person sees it as a card; tell them in a sentence what changed.',
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
  const outcome = await refreshTable(deps(ctx), table.id, { id: actor.id, name: actor.name }, origin(ctx, tu))
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
  const refusal = await othersTable(ctx, actor, { id: table.id }, parsed.data.confirmation, `Removing the saved table ${name}, made by ${table.createdByName},`, REMOVE_SAVED_TABLE_TOOL_NAME)
  if (refusal) return failed(tu, refusal)
  const outcome = await removeTable(deps(ctx), actor, table.id, origin(ctx, tu))
  if (!outcome.ok) return failed(tu, outcome.error)
  emitCard(ctx, outcome, 'remove')
  return answered(tu, { removed: true, name: `ai_saved.${name}`, note: 'Removed: queries, reports and automations that read it fail from now on. The person sees it as a card.' })
}

const origin = (ctx: SavedTableToolContext, tu: ToolUse) => ({ conversationId: ctx.conversationId, turnId: ctx.turnId, toolUseId: tu.id })
const deps = (ctx: SavedTableToolContext) => ({ db: ctx.db, readers: ctx.readers, timeZone: ctx.config.FACTORY_TIMEZONE })

/**
 * Why a change to a table someone else made is not made now, or null: a table of the person's own (or none by that
 * name) goes on, someone else's only at the person's own word in this question (personsOwnWords). Whether they may
 * change it at all is savedTables.ts's to say.
 */
async function othersTable(
  ctx: SavedTableToolContext,
  actor: SavedTableActor,
  table: { id?: string; name?: string },
  confirmation: string | null | undefined,
  what: string,
  tool: string,
): Promise<string | null> {
  // Only the owner may change another's table at all; anyone else is told so by savedTables.ts.
  if (!actor.owner) return null
  const maker = await tableMaker(ctx.db, table)
  if (maker === null || maker === actor.id) return null
  return personsOwnWords(ctx.db, ctx.turnId, confirmation ?? null, what, tool)
}

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
