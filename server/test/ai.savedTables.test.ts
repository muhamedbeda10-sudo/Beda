import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ApiErrorBody } from '@qc/shared/api'
import type { AiAccess, AiMessagesResponse, AiStreamEvent } from '@qc/shared/ai'
import type { SavedTable, SavedTableRowsResponse, SavedTablesResponse } from '@qc/shared/savedTables'
import { TestApp, type Session } from './harness'
import { text, type FakeReply } from './aiFake'
import { runReadOnlyQuery } from '../src/ai/runQuery'
import {
  describeSavedTables,
  domainsRead,
  listSavedTables,
  refreshDue,
  refreshOrder,
  refreshTable,
  removeTable,
  saveTable,
  savedTablesNamed,
  type SavedTableActor,
  type SavedTableDefinition,
  type SavedTableOutcome,
} from '../src/ai/savedTables'

// The assistant's saved tables: results kept to build on, computed again by
// the database alone, readable by exactly the people who may read what their
// query reads (asked of PostgreSQL each time a table is computed), changed
// only by whoever made them or the assistant's owner, every change in the
// history and the audit log.

const app = new TestApp()
let owner: Session
let insp: Session
let sup: Session
const KEY = `sk-ant-api03-${'k_9-'.repeat(20)}LaSt`
const ALL = ['inspection', 'orders', 'materials', 'audit', 'production'] as const

const deps = () => ({ db: app.db, readers: app.aiReader, timeZone: app.config.FACTORY_TIMEZONE })

async function grant(person: Session, domains: string[]): Promise<AiAccess> {
  const body = { enabled: true, domains, model: 'claude-sonnet-5-5', effort: 'medium', monthlyCapUsd: 50 }
  const res = await app.api<AiAccess>('PUT', `/api/ai/access/${person.user.id}`, { token: owner.token, body })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}

const actor = (s: Session, domains: readonly string[], isOwner = false): SavedTableActor => ({ id: s.user.id, name: s.user.name, owner: isOwner, domains: [...domains] as SavedTableActor['domains'] })
const ownerActor = () => actor(owner, ALL, true)

const queryTable = (name: string, sql: string, refresh: 'never' | 'hourly' | 'daily' = 'daily', notes: Record<string, string> = {}): SavedTableDefinition => ({
  name,
  title: `Table ${name}`,
  description: `What ${name} holds.`,
  source: 'query',
  sql,
  refresh,
  notes,
})

function saved(o: SavedTableOutcome): SavedTable {
  if (!o.ok) throw new Error(o.error)
  return o.table
}

/** Reads a saved table as the role of exactly these domains. */
const readAs = (domains: readonly string[], sql: string) =>
  runReadOnlyQuery(app.aiReader.poolFor(domains as SavedTableActor['domains']), sql, { maxRows: 100, timeoutMs: 5000, timeZone: app.config.FACTORY_TIMEZONE })

const exists = async (name: string) => (await app.db.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [`ai_saved.${name}`])).rows[0].t !== null

beforeAll(async () => {
  await app.start()
  await app.resetDatabase()
  owner = await app.register('admin', 'Owner Admin')
  for (const [username, name, role] of [
    ['insp', 'Inspector One', 'inspector'],
    ['sup', 'Super Visor', 'supervisor'],
  ]) {
    expect((await app.api('POST', '/api/users', { token: owner.token, body: { username, password: 'Password#1', name, role } })).status).toBe(201)
  }
  insp = await app.login('insp')
  sup = await app.login('sup')
  for (const code of ['58', '31', '12']) {
    expect((await app.api('POST', '/api/master/machines', { token: owner.token, body: { code, name: `Machine ${code}`, displayName: `${code}. Machine`, process: 'forming' } })).status).toBe(201)
  }
  expect((await app.api('PUT', '/api/ai/key', { token: owner.token, body: { apiKey: KEY } })).status).toBe(200)
  await grant(insp, ['materials'])
  await grant(sup, ['inspection', 'audit'])
})
afterAll(() => app.stop())
beforeEach(() => {
  for (const s of [owner, insp, sup]) app.aiLimiter.reset(s.user.id)
})

describe('what a query reads', () => {
  it('is asked of PostgreSQL: none for the machine register, the domain of each view otherwise', async () => {
    expect(await domainsRead(app.aiReader, 'SELECT machine_code FROM ai.machines')).toEqual({ domains: [] })
    expect(await domainsRead(app.aiReader, 'SELECT name FROM ai.users')).toEqual({ domains: ['audit'] })
    expect(await domainsRead(app.aiReader, 'SELECT m.machine_code, u.name FROM ai.machines m CROSS JOIN ai.users u CROSS JOIN (SELECT count(*) FROM ai.coils) c')).toEqual({
      domains: ['materials', 'audit'],
    })
    const bad = await domainsRead(app.aiReader, 'SELECT nope FROM ai.machines')
    expect(bad).toMatchObject({ error: expect.stringMatching(/column "nope" does not exist/) })
    expect(await domainsRead(app.aiReader, 'SELECT * FROM public.users')).toMatchObject({ error: expect.stringMatching(/saved tables in schema ai_saved, can be read/) })
  })

  it('names the saved tables a query reads, quoted or not, once each', () => {
    expect(savedTablesNamed('SELECT * FROM ai_saved.a JOIN ai_saved."b_c" USING (x) JOIN AI_SAVED . a USING (y) -- ai_saved.hidden')).toEqual(['a', 'b_c'])
  })

  it('computes tables after the due tables they are built on', () => {
    const order = refreshOrder([
      { name: 'c', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a', 'outside'] },
      { name: 'a', dependsOn: ['a'] },
      { name: 'loop1', dependsOn: ['loop2'] },
      { name: 'loop2', dependsOn: ['loop1'] },
    ])
    expect(order.map((t) => t.name).slice(0, 3)).toEqual(['a', 'b', 'c'])
    expect(order.map((t) => t.name).sort()).toEqual(['a', 'b', 'c', 'loop1', 'loop2'])
  })
})

describe('saving a table from a query', () => {
  it('stores the result, typed, for exactly the roles that may read what it reads', async () => {
    const t = saved(await saveTable(deps(), ownerActor(), queryTable('people', `SELECT name, role, created_at FROM ai.users ORDER BY name`, 'daily', { role: 'The account\'s role.' })))
    expect(t).toMatchObject({ name: 'people', source: 'query', refresh: 'daily', domains: ['audit'], rowCount: 3, version: 1, dependsOn: [], createdByName: 'Owner Admin' })
    expect(t.columns).toEqual([
      { name: 'name', type: 'text', note: '' },
      { name: 'role', type: 'text', note: "The account's role." },
      { name: 'created_at', type: 'timestamp with time zone', note: '' },
    ])
    expect(t.nextRefreshAt).not.toBeNull()

    // Only roles holding the audit domain read it.
    expect((await readAs(['audit'], 'SELECT name FROM ai_saved.people ORDER BY 1')).rows).toEqual([['Inspector One'], ['Owner Admin'], ['Super Visor']])
    const refused = await readAs(['materials', 'inspection', 'orders', 'production'], 'SELECT * FROM ai_saved.people')
    expect(refused).toMatchObject({ ok: false, code: '42501' })

    // Listed for those who may read it, and in their data dictionary.
    expect((await listSavedTables(app.db, actor(insp, ['materials']))).map((x) => x.name)).toEqual([])
    expect((await listSavedTables(app.db, actor(sup, ['inspection', 'audit']))).map((x) => x.name)).toEqual(['people'])
    const doc = await describeSavedTables(app.db, ['audit'])
    expect(doc).toContain('### ai_saved.people')
    expect(doc).toContain("- role text: The account's role.")
    expect(await describeSavedTables(app.db, ['materials'])).toBe('')

    // The history and the audit log.
    const changes = await app.db.query(`SELECT action, version, row_count AS "rowCount", definition ->> 'sql' AS sql FROM ai_saved_table_changes WHERE table_id = $1`, [t.id])
    expect(changes.rows).toEqual([{ action: 'create', version: 1, rowCount: 3, sql: 'SELECT name, role, created_at FROM ai.users ORDER BY name' }])
    expect((await app.db.query(`SELECT action FROM audit_log WHERE entity = 'AiSavedTable' AND entity_id = $1`, [t.id])).rows).toEqual([{ action: 'create' }])
  })

  it('refuses what the person may not read, a name in use, and columns a table cannot have', async () => {
    const reads = await saveTable(deps(), actor(insp, ['materials']), queryTable('accounts', 'SELECT name FROM ai.users'))
    expect(reads).toEqual({ ok: false, error: 'Nothing was saved: The query reads data this person may not read (audit).' })
    const taken = await saveTable(deps(), actor(sup, ['inspection', 'audit']), queryTable('people', 'SELECT name FROM ai.users'))
    expect(taken).toMatchObject({ ok: false, error: expect.stringMatching(/already exists \(Table people, made by Owner Admin\)/) })
    const unnamed = await saveTable(deps(), ownerActor(), queryTable('unnamed', 'SELECT count(*), 1 FROM ai.machines'))
    expect(unnamed).toMatchObject({ ok: false, error: expect.stringMatching(/Name every column in lowercase/) })
    const twice = await saveTable(deps(), ownerActor(), queryTable('twice', 'SELECT machine_code AS x, machine AS x FROM ai.machines'))
    expect(twice).toMatchObject({ ok: false, error: expect.stringMatching(/x appear more than once/) })
    const name = await saveTable(deps(), ownerActor(), queryTable('Bad-Name', 'SELECT machine_code FROM ai.machines'))
    expect(name).toMatchObject({ ok: false, error: expect.stringMatching(/^name: /) })
    const write = await saveTable(deps(), ownerActor(), queryTable('writes', 'DELETE FROM ai.machines'))
    expect(write).toMatchObject({ ok: false, error: expect.stringMatching(/Only a single SELECT/) })
    expect(await exists('accounts')).toBe(false)
  })

  it('is replaced only by whoever made it or the owner, and keeps its id', async () => {
    const before = (await listSavedTables(app.db, ownerActor())).find((x) => x.name === 'people')!
    const notTheirs = await saveTable(deps(), actor(sup, ['inspection', 'audit']), queryTable('people', 'SELECT name FROM ai.users'), true)
    expect(notTheirs).toMatchObject({ ok: false, error: expect.stringMatching(/only they, or the assistant's owner, may replace it/) })
    const t = saved(await saveTable(deps(), ownerActor(), queryTable('people', `SELECT name, role FROM ai.users WHERE role <> 'admin'`), true))
    expect(t).toMatchObject({ id: before.id, version: 2, rowCount: 2 })
    expect(t.columns.map((c) => c.name)).toEqual(['name', 'role'])
    const missing = await saveTable(deps(), ownerActor(), queryTable('nothing_here', 'SELECT 1 AS one'), true)
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/no saved table named nothing_here to replace/) })
  })
})

describe('tables built on tables', () => {
  it('follow what they read when computed again: a table that reads a narrower one narrows too', async () => {
    const base = saved(await saveTable(deps(), ownerActor(), queryTable('machine_codes', 'SELECT machine_code AS code FROM ai.machines ORDER BY 1')))
    expect(base.domains).toEqual([])
    const derived = saved(await saveTable(deps(), actor(insp, ['materials']), queryTable('machine_count', 'SELECT count(*)::int AS machines FROM ai_saved.machine_codes')))
    expect(derived).toMatchObject({ domains: [], dependsOn: ['machine_codes'], rowCount: 1 })
    expect((await readAs(['materials'], 'SELECT machines FROM ai_saved.machine_count')).rows).toEqual([[3]])

    // A table others are built on is not removed.
    const blocked = await removeTable(deps(), ownerActor(), base.id)
    expect(blocked).toEqual({ ok: false, error: 'Other saved tables are built on machine_codes: machine_count. Remove or replace them first.' })

    // The base now reads accounts: the table built on it is for the audit domain from its next computation.
    saved(await saveTable(deps(), ownerActor(), queryTable('machine_codes', 'SELECT m.machine_code AS code FROM ai.machines m CROSS JOIN (SELECT 1 FROM ai.users LIMIT 1) u'), true))
    const again = saved(await refreshTable(deps(), derived.id, { id: insp.user.id, name: insp.user.name }))
    expect(again.domains).toEqual(['audit'])
    expect(await readAs(['materials'], 'SELECT * FROM ai_saved.machine_count')).toMatchObject({ ok: false, code: '42501' })
    expect((await listSavedTables(app.db, actor(insp, ['materials']))).map((x) => x.name)).toEqual([])
  })

  it('computes the due tables, recording a failure without losing the rows before it', async () => {
    const t = saved(await saveTable(deps(), ownerActor(), queryTable('machines_hourly', 'SELECT machine_code AS code FROM ai.machines', 'hourly')))
    expect((await app.api('POST', '/api/master/machines', { token: owner.token, body: { code: '77', name: 'Machine 77', displayName: '77. Machine', process: 'forming' } })).status).toBe(201)
    await app.db.query(`UPDATE ai_saved_tables SET next_refresh_at = now() - interval '1 minute' WHERE id = $1`, [t.id])
    expect(await refreshDue(deps())).toBeGreaterThanOrEqual(1)
    const after = (await listSavedTables(app.db, ownerActor())).find((x) => x.id === t.id)!
    expect(after.rowCount).toBe(4)
    expect(new Date(after.nextRefreshAt!).getTime()).toBeGreaterThan(Date.now())

    // Its query no longer runs (a column gone, say): the rows stay, the error is recorded, it is tried again within the hour.
    await app.db.query(`UPDATE ai_saved_tables SET sql = 'SELECT gone FROM ai.machines', next_refresh_at = now() - interval '1 minute' WHERE id = $1`, [t.id])
    await refreshDue(deps())
    const failed = (await listSavedTables(app.db, ownerActor())).find((x) => x.id === t.id)!
    expect(failed).toMatchObject({ rowCount: 4, lastError: expect.stringMatching(/column "gone" does not exist/) })
    expect((await readAs(['materials'], 'SELECT count(*) FROM ai_saved.machines_hourly')).rows).toEqual([[4]])
    await app.db.query(`UPDATE ai_saved_tables SET sql = 'SELECT machine_code AS code FROM ai.machines' WHERE id = $1`, [t.id])
  })
})

describe('rows written out', () => {
  it('are for everyone given the assistant, checked value by value', async () => {
    const def: SavedTableDefinition = {
      name: 'reject_targets',
      title: 'Reject-rate targets',
      description: 'The target reject rate of each process, as the quality manager set them.',
      source: 'rows',
      columns: [
        { name: 'process', type: 'text' },
        { name: 'target_pct', type: 'number', note: 'Percent, 0 to 100.' },
        { name: 'from_day', type: 'date' },
      ],
      rows: [
        ['forming', 1.5, '2026-10-01'],
        ['welding', '2', null],
      ],
    }
    const t = saved(await saveTable(deps(), actor(insp, ['materials']), def))
    expect(t).toMatchObject({ source: 'rows', refresh: 'never', domains: [], rowCount: 2, nextRefreshAt: null })
    expect(t.columns).toEqual([
      { name: 'process', type: 'text', note: '' },
      { name: 'target_pct', type: 'numeric', note: 'Percent, 0 to 100.' },
      { name: 'from_day', type: 'date', note: '' },
    ])
    expect((await readAs(['audit'], 'SELECT process, target_pct, from_day FROM ai_saved.reject_targets ORDER BY 1')).rows).toEqual([
      ['forming', 1.5, '2026-10-01'],
      ['welding', 2, null],
    ])
    const wrong = await saveTable(deps(), actor(insp, ['materials']), { ...def, name: 'wrong', rows: [['x', 'lots', null]] })
    expect(wrong).toEqual({ ok: false, error: 'Nothing was saved: Row 1, column target_pct: "lots" is not a number.' })
    const short = await saveTable(deps(), actor(insp, ['materials']), { ...def, name: 'short', rows: [['x']] })
    expect(short).toMatchObject({ ok: false, error: expect.stringMatching(/Row 1 has 1 values; each row needs 3/) })
    expect(await refreshTable(deps(), t.id, { id: insp.user.id, name: insp.user.name })).toEqual({ ok: false, error: 'Rows written out are not computed: replace the table to change them.' })
  })
})

describe('the Saved tables page', () => {
  it('lists, previews, computes again and removes, as each person may', async () => {
    const list = await app.api<SavedTablesResponse>('GET', '/api/ai/saved-tables', { token: insp.token })
    expect(list.status).toBe(200)
    const mine = list.body.tables.find((x) => x.name === 'reject_targets')!
    expect(mine).toMatchObject({ mayRemove: true, mayRefresh: false })
    const others = list.body.tables.find((x) => x.name === 'machines_hourly')!
    expect(others).toMatchObject({ mayRemove: false, mayRefresh: true })
    expect(list.body.tables.some((x) => x.name === 'people')).toBe(false)

    const rows = await app.api<SavedTableRowsResponse>('GET', `/api/ai/saved-tables/${mine.id}/rows`, { token: insp.token })
    expect(rows.body).toMatchObject({ columns: ['process', 'target_pct', 'from_day'], rowCount: 2, truncated: false })

    // A table they may not read is not there for them.
    const people = (await listSavedTables(app.db, ownerActor())).find((x) => x.name === 'people')!
    expect((await app.api('GET', `/api/ai/saved-tables/${people.id}/rows`, { token: insp.token })).status).toBe(404)

    const refreshed = await app.api<SavedTable>('POST', `/api/ai/saved-tables/${others.id}/refresh`, { token: insp.token })
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
    expect(refreshed.body.rowCount).toBe(4)

    const refused = await app.api<ApiErrorBody>('DELETE', `/api/ai/saved-tables/${others.id}`, { token: insp.token })
    expect(refused.status).toBe(403)
    expect((await app.api('DELETE', `/api/ai/saved-tables/${mine.id}`, { token: insp.token })).status).toBe(204)
    expect(await exists('reject_targets')).toBe(false)
    // Its name can be used again.
    saved(await saveTable(deps(), actor(insp, ['materials']), queryTable('reject_targets', 'SELECT machine_code AS code FROM ai.machines')))

    // Someone not given the assistant has no page.
    const viewer = await app.register('outsider', 'Out Sider')
    expect((await app.api('GET', '/api/ai/saved-tables', { token: viewer.token })).status).toBe(403)
  })
})

describe('in a conversation', () => {
  type Done = Extract<AiStreamEvent, { type: 'done' }>
  async function ask(as: Session, message: string): Promise<{ events: AiStreamEvent[]; done?: Done; conversationId: string }> {
    const res = await app.api<string>('POST', '/api/ai/chat', { token: as.token, body: { message, clientId: randomUUID() } })
    expect(res.status, String(res.body)).toBe(200)
    const events = res.body
      .split('\n\n')
      .filter((f) => f && !f.startsWith(':'))
      .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as AiStreamEvent)
    const start = events.find((e): e is Extract<AiStreamEvent, { type: 'start' }> => e.type === 'start')
    return { events, done: events.find((e): e is Done => e.type === 'done'), conversationId: start?.conversation.id ?? '' }
  }
  const tool = (id: string, name: string, input: object): FakeReply => ({ content: [{ type: 'tool_use', id, name, input } as never] })

  it('has the tools and the section, saves a table as a card, and the card stays with the answer', async () => {
    app.model.reply(
      tool('toolu_save_1', 'save_table', {
        name: 'machine_register',
        title: 'Machine register',
        description: 'Every machine with its code.',
        source: 'query',
        sql: 'SELECT machine_code AS code, machine AS name FROM ai.machines ORDER BY 1',
        refresh: 'daily',
      }),
      { content: [text('Saved the machine register as a table.')] },
    )
    const calls = app.model.calls.length
    const res = await ask(insp, 'Keep the machine list as a table')
    const first = app.model.calls[calls].params
    const names = (first.tools as { name: string }[]).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_saved_tables', 'save_table', 'refresh_saved_table', 'remove_saved_table']))
    const system = (first.system as { text: string }[])[0].text
    expect(system).toContain('# Heavy work and saved tables')
    expect(system).toContain('### ai_saved.machines_hourly')
    expect(system).not.toContain('### ai_saved.people')

    const card = res.events.find((e): e is Extract<AiStreamEvent, { type: 'saved-table' }> => e.type === 'saved-table')!
    expect(card.part).toMatchObject({ type: 'saved-table', name: 'machine_register', action: 'create', rowCount: 4, columns: ['code', 'name'], state: 'current' })
    const result = app.model.calls[calls + 1].params.messages.at(-1)!.content as { type: string; content: string }[]
    expect(JSON.parse(result[0].content)).toMatchObject({ saved: true, name: 'ai_saved.machine_register', rowCount: 4, readableBy: 'everyone given the assistant' })

    const messages = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${res.conversationId}/messages`, { token: insp.token })
    const answer = messages.body.messages.find((m) => m.role === 'assistant')!
    expect(answer.parts[0]).toMatchObject({ type: 'saved-table', name: 'machine_register', state: 'current' })

    // Removed since: the card says so.
    const t = (await listSavedTables(app.db, actor(insp, ['materials']))).find((x) => x.name === 'machine_register')!
    saved(await removeTable(deps(), actor(insp, ['materials']), t.id))
    const reread = await app.api<AiMessagesResponse>('GET', `/api/ai/conversations/${res.conversationId}/messages`, { token: insp.token })
    expect(reread.body.messages.find((m) => m.role === 'assistant')!.parts[0]).toMatchObject({ state: 'removed' })
  })
})
