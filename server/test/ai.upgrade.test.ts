import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TestApp } from './harness'
import { defaultMigrationsDir, migrate } from '../src/db/migrate'
import { ACCESS_NOTICE } from '../src/ai/access'
import { NOT_AVAILABLE_MESSAGE } from '../src/ai/assistant'
import { loadDisplayMessages } from '../src/ai/transcript'

// §20 — moving from phases 1 and 2 to one owner and access person by person:
// what the database already holds is brought in line with what the chat may
// show now. No amounts, and no talk of keys or settings, for anyone.

const app = new TestApp()
beforeAll(() => app.start())
afterAll(() => app.stop())

/** The database as phase 2 left it: every migration before 0033. */
async function migrateToPhase2(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qc-migrations-'))
  try {
    const all = defaultMigrationsDir()
    for (const file of await readdir(all)) {
      if (/^\d{4}_.+\.sql$/.test(file) && file < '0033') await copyFile(path.join(all, file), path.join(dir, file))
    }
    await app.db.query('DROP SCHEMA IF EXISTS ai CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await migrate(app.db, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('§20 upgrading from phases 1 and 2', () => {
  it('takes the cap’s amount and the talk of keys and settings out of the notices answers kept', async () => {
    await migrateToPhase2()
    const user = (
      await app.db.query<{ id: string }>(`INSERT INTO users (username, name, role, password_hash) VALUES ('admin', 'Admin', 'admin', 'x') RETURNING id`)
    ).rows[0].id
    const conversation = (
      await app.db.query<{ id: string }>(
        `INSERT INTO ai_conversations (user_id, title, model, system_prompt, tools) VALUES ($1, 'Old questions', 'claude-sonnet-5-5', 'prompt', '[]') RETURNING id`,
        [user],
      )
    ).rows[0].id
    // What phases 1 and 2 kept, word for word, and two notices that stay as they are.
    const kept: [string, string][] = [
      ['cap', "This month's spending cap ($50.00) would be passed, so the answer stopped. An administrator can raise the cap under Administration → AI assistant."],
      ['error', 'The API key was refused by Anthropic. An administrator can set a new one under Administration → AI assistant.'],
      ['error', 'Anthropic does not allow this API key to use the assistant. An administrator can check the key under Administration → AI assistant.'],
      ['error', "This API key cannot use the assistant's model. An administrator can check the key under Administration → AI assistant."],
      ['error', 'The Anthropic account behind the API key cannot be billed. An administrator can check it in the Anthropic console.'],
      ['error', 'Claude is busy right now — try again in a minute.'],
      ['stopped', 'Stopped before the answer was finished.'],
    ]
    for (const [i, [stopReason, notice]] of kept.entries()) {
      await app.db.query(
        `INSERT INTO ai_turns (conversation_id, user_id, client_id, question, status, stop_reason, notice, created_at, finished_at)
         VALUES ($1, $2, $3, $4, 'done', $5, $6, now() + make_interval(secs => $7), now() + make_interval(secs => $7))`,
        [conversation, user, `client-${i}`, `Question ${i}`, stopReason, notice, i],
      )
    }

    await migrate(app.db)
    const shown = (await loadDisplayMessages(app.db, conversation)).filter((m) => m.role === 'assistant').map((m) => [m.stopReason, m.notice])
    expect(shown).toEqual([
      ['cap', ACCESS_NOTICE.appCap],
      ['error', NOT_AVAILABLE_MESSAGE],
      ['error', NOT_AVAILABLE_MESSAGE],
      ['error', NOT_AVAILABLE_MESSAGE],
      ['error', NOT_AVAILABLE_MESSAGE],
      ['error', 'Claude is busy right now — try again in a minute.'],
      ['stopped', 'Stopped before the answer was finished.'],
    ])
    for (const [, notice] of shown) expect(notice).not.toMatch(/\$|administrat|key/i)
  })
})
