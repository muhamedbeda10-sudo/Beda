// ============================================================================
// The assistant's saved tables: what it keeps to build on. A table is either
// a query over the factory record (ai.* views, other saved tables) whose
// result is stored and recomputed on a schedule by the database alone, or
// rows the assistant wrote out (a mapping, a list of targets). Questions,
// reports and automations read them like the views, as ai_saved.<name>.
//
// Who may read one is what its query reads: a table built from the
// production record is for the people who may read that record, worked out
// again every time it is computed. Rows written out are for everyone given
// the assistant.
// ============================================================================

import type { AiCell, AiDomain } from './ai'

/** Where a table's rows come from. */
export type SavedTableSource = 'query' | 'rows'
/** How often a query's table is computed again: never (a snapshot), every hour, or every night. */
export type SavedTableRefresh = 'never' | 'hourly' | 'daily'
export const SAVED_TABLE_REFRESHES: readonly SavedTableRefresh[] = ['never', 'hourly', 'daily']

/** A rows table's column types, as the assistant names them. */
export type SavedTableColumnType = 'text' | 'number' | 'integer' | 'date' | 'timestamp' | 'boolean'
export const SAVED_TABLE_COLUMN_TYPES: readonly SavedTableColumnType[] = ['text', 'number', 'integer', 'date', 'timestamp', 'boolean']

/** The schema saved tables live in, as queries name them. */
export const SAVED_TABLE_SCHEMA = 'ai_saved'
/** A table's name: lowercase letters, digits and _, starting with a letter. */
export const SAVED_TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/
/** A column's name in a saved table. */
export const SAVED_TABLE_COLUMN_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/
/** The most rows a query's table may hold. */
export const SAVED_TABLE_MAX_ROWS = 200_000
/** The most rows the assistant may write out by hand. */
export const SAVED_TABLE_MAX_LITERAL_ROWS = 5_000
/** The most columns a saved table may have. */
export const SAVED_TABLE_MAX_COLUMNS = 100
/** A table's title, its summary and its description, at most. */
export const SAVED_TABLE_TITLE_MAX = 120
export const SAVED_TABLE_SUMMARY_MAX = 300
export const SAVED_TABLE_DESCRIPTION_MAX = 2_000
/** A column's note at most. */
export const SAVED_TABLE_NOTE_MAX = 300
/** Rows a preview shows. */
export const SAVED_TABLE_PREVIEW_ROWS = 100
/** Most live saved tables in all. */
export const SAVED_TABLE_MAX_LIVE = 300

export const SAVED_TABLE_REFRESH_LABEL: Record<SavedTableRefresh, string> = {
  never: 'Kept as computed',
  hourly: 'Every hour',
  daily: 'Every night',
}

export interface SavedTableColumn {
  name: string
  /** PostgreSQL's name of its type (bigint, numeric, text, date, timestamp with time zone…). */
  type: string
  /** What the column holds, as the assistant described it; empty when it did not. */
  note: string
}

export interface SavedTable {
  id: string
  name: string
  title: string
  /** What the table shows, in a sentence or two for anyone; empty for a table saved before summaries. */
  summary: string
  /** The full account: what a row is, where the rows come from, the rules applied. */
  description: string
  source: SavedTableSource
  /** The query a query's table is computed from; null for rows written out. */
  sql: string | null
  refresh: SavedTableRefresh
  /** The data its query reads: who may read the table. Empty: everyone given the assistant. */
  domains: AiDomain[]
  /** Saved tables its query reads. */
  dependsOn: string[]
  columns: SavedTableColumn[]
  rowCount: number | null
  version: number
  refreshedAt: string | null
  nextRefreshAt: string | null
  /** The last computation failed (the rows kept are the ones before it): why. */
  lastError: string | null
  lastErrorAt: string | null
  createdByName: string
  createdAt: string
  updatedByName: string
  updatedAt: string
  /** Whether the person asking may compute it again now (anyone who may read it). */
  mayRefresh: boolean
  /** Whether the person asking may remove it: whoever made it, and the assistant's owner. */
  mayRemove: boolean
}

export interface SavedTablesResponse {
  tables: SavedTable[]
}

export interface SavedTableRowsResponse {
  columns: string[]
  rows: AiCell[][]
  /** More rows than the preview shows. */
  truncated: boolean
  rowCount: number | null
}

/** A saved table the assistant made, changed, computed again or removed, as a card in its answer. */
export interface AiSavedTablePart {
  type: 'saved-table'
  changeId: string
  tableId: string
  name: string
  title: string
  action: 'create' | 'replace' | 'refresh' | 'remove'
  source: SavedTableSource
  refresh: SavedTableRefresh
  /** As the change left it. */
  rowCount: number | null
  columns: string[]
  /** How the table stands now: as this card left it, changed since, or removed. */
  state: 'current' | 'changed' | 'removed'
}
