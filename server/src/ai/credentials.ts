// ============================================================================
// §20 — the Anthropic API key. An administrator sets it in the app; it is
// kept encrypted (AES-256-GCM) under a key derived from JWT_SECRET, so a copy
// of the database alone does not give it away. It is never returned by any
// endpoint, never logged and never written to the audit log: only its last
// four characters are shown.
//
// ANTHROPIC_API_KEY in the server's environment, when set, wins over the key
// set in the app.
// ============================================================================

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { AiKeyState } from '@qc/shared/ai'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'

/** How the encryption key is derived (ai_credentials.key_version). */
const KEY_VERSION = 1
const HKDF_SALT = 'qc-ai-credentials'
const HKDF_INFO = 'anthropic-api-key:v1'

export interface SealedKey {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
}

function encryptionKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', jwtSecret, HKDF_SALT, HKDF_INFO, 32))
}

export function sealApiKey(jwtSecret: string, apiKey: string): SealedKey {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(jwtSecret), iv)
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag() }
}

/** The key, or null when it cannot be read back (JWT_SECRET changed since it was set). */
export function openApiKey(jwtSecret: string, sealed: SealedKey): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(jwtSecret), sealed.iv)
    decipher.setAuthTag(sealed.authTag)
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const last4 = (apiKey: string) => apiKey.slice(-4)

/** How the audit log names a key: whether one is set and its last four characters, never the key. */
export const auditKeyLabel = (tail: string | null) => (tail ? `set (…${tail})` : 'not set')

export interface ResolvedKey {
  /** The key to call Anthropic with; null when there is none that can be used. */
  apiKey: string | null
  state: AiKeyState
}

interface CredentialRow {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
  keyVersion: number
  last4: string
  updatedAt: string
  updatedByName: string
}

/** The key the assistant would use now, and what may be shown about it. */
export async function resolveApiKey(q: Queryable, config: Config): Promise<ResolvedKey> {
  if (config.ANTHROPIC_API_KEY) {
    return { apiKey: config.ANTHROPIC_API_KEY, state: { set: true, source: 'environment', last4: last4(config.ANTHROPIC_API_KEY) } }
  }
  const { rows } = await q.query<CredentialRow>(
    `SELECT ciphertext, iv, auth_tag AS "authTag", key_version AS "keyVersion", last4,
            updated_at AS "updatedAt", updated_by_name AS "updatedByName"
       FROM ai_credentials WHERE id = 1`,
  )
  const row = rows[0]
  if (!row) return { apiKey: null, state: { set: false, source: null } }
  const apiKey = row.keyVersion === KEY_VERSION ? openApiKey(config.JWT_SECRET, row) : null
  const state: AiKeyState = { set: true, source: 'app', last4: row.last4, updatedAt: row.updatedAt, updatedByName: row.updatedByName }
  if (apiKey === null) state.unreadable = true
  return { apiKey, state }
}

/** The last four characters of the key set in the app, for the audit trail; null when none is set. */
export async function storedKeyTail(q: Queryable): Promise<string | null> {
  const { rows } = await q.query<{ last4: string }>(`SELECT last4 FROM ai_credentials WHERE id = 1`)
  return rows[0]?.last4 ?? null
}

export async function storeApiKey(q: Queryable, config: Config, apiKey: string, by: { id: string; name: string }): Promise<void> {
  const sealed = sealApiKey(config.JWT_SECRET, apiKey)
  await q.query(
    `INSERT INTO ai_credentials (id, ciphertext, iv, auth_tag, key_version, last4, updated_by_id, updated_by_name, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
       key_version = EXCLUDED.key_version, last4 = EXCLUDED.last4, updated_by_id = EXCLUDED.updated_by_id,
       updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
    [sealed.ciphertext, sealed.iv, sealed.authTag, KEY_VERSION, last4(apiKey), by.id, by.name],
  )
}

/** Remove the key set in the app. A secret is not evidence: the row goes. */
export async function removeApiKey(q: Queryable): Promise<boolean> {
  const { rowCount } = await q.query(`DELETE FROM ai_credentials WHERE id = 1`)
  return (rowCount ?? 0) > 0
}
