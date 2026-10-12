// ============================================================================
// §24 — the VAPID keys that sign this server's pushes. Set in the environment
// (VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY) they are used as they are;
// otherwise a pair is made the first time one is needed and kept in
// app_settings, so every instance and every restart signs with the same pair
// (a new pair would cut every device off). Two instances making one at once
// both keep the first that was stored.
//
// The subject a push service may contact is VAPID_SUBJECT, else the address
// the app is opened at (stored when a device subscribes), else a mailto.
// ============================================================================

import webpush from 'web-push'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'

const KEYS_SETTING = 'push.vapid'
const ORIGIN_SETTING = 'push.origin'

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

export async function vapidKeys(q: Queryable, config: Config): Promise<VapidKeys> {
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) return { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY }
  const read = async () => (await q.query<{ value: VapidKeys }>(`SELECT value FROM app_settings WHERE key = $1`, [KEYS_SETTING])).rows[0]?.value ?? null
  const stored = await read()
  if (stored?.publicKey && stored.privateKey) return stored
  const made = webpush.generateVAPIDKeys()
  await q.query(`INSERT INTO app_settings (key, value, updated_by_name) VALUES ($1, $2::jsonb, 'system') ON CONFLICT (key) DO NOTHING`, [KEYS_SETTING, JSON.stringify(made)])
  return (await read()) ?? made
}

/** Remember the https address the app is opened at, as the subject of its pushes. */
export async function rememberOrigin(q: Queryable, origin: string | undefined): Promise<void> {
  if (!origin || !/^https:\/\/[^/\s]+$/.test(origin)) return
  await q.query(
    `INSERT INTO app_settings (key, value, updated_by_name) VALUES ($1, $2::jsonb, 'system')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE app_settings.value <> EXCLUDED.value`,
    [ORIGIN_SETTING, JSON.stringify(origin)],
  )
}

export async function vapidSubject(q: Queryable, config: Config): Promise<string> {
  if (config.VAPID_SUBJECT) return config.VAPID_SUBJECT
  const origin = (await q.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [ORIGIN_SETTING])).rows[0]?.value
  return origin ?? 'mailto:qc-system@example.com'
}
