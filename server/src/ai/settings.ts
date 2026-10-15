// ============================================================================
// §20 — whether the assistant may answer now, and what it has cost. The
// settings (on/off, the monthly cap) live in app_settings beside the KPI
// thresholds; the spend is read from ai_usage on every check, not kept in
// memory, so every App Service instance holds the same cap. All of it is the
// owner's to see and change (owner.ts); a person learns only whether they
// may ask now (access.ts).
// ============================================================================

import {
  AI_DEFAULT_SETTINGS,
  AI_MAX_MONTHLY_CAP_USD,
  AI_MODEL,
  isAiModel,
  type AiKeyState,
  type AiSettings,
  type AiStatusResponse,
  type AiUnavailableReason,
} from '@qc/shared/ai'
import type { Config } from '../config'
import type { Queryable } from '../db/pool'
import { resolveApiKey } from './credentials'
import { minCallWorstCaseUsd } from './models'
import { monthSpend } from './transcript'

export const AI_SETTINGS_KEY = 'ai-assistant'

export interface StoredAiSettings {
  settings: AiSettings
  updatedAt?: string
  updatedByName?: string
}

/** The stored settings over the defaults, so a setting added later still has a value. */
export async function loadAiSettings(q: Queryable): Promise<StoredAiSettings> {
  const { rows } = await q.query<{ value: Partial<AiSettings>; updatedAt: string; updatedByName: string | null }>(
    `SELECT value, updated_at AS "updatedAt", updated_by_name AS "updatedByName" FROM app_settings WHERE key = $1`,
    [AI_SETTINGS_KEY],
  )
  const row = rows[0]
  const settings: AiSettings = { ...AI_DEFAULT_SETTINGS }
  if (row) {
    if (typeof row.value.enabled === 'boolean') settings.enabled = row.value.enabled
    const cap = row.value.monthlyCapUsd
    if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 && cap <= AI_MAX_MONTHLY_CAP_USD) settings.monthlyCapUsd = cap
    // A model no longer offered reads as the default, never as something unchecked.
    const mtcModel: unknown = row.value.mtcModel
    if (typeof mtcModel === 'string' && isAiModel(mtcModel)) settings.mtcModel = mtcModel
  }
  return { settings, updatedAt: row?.updatedAt ?? undefined, updatedByName: row?.updatedByName ?? undefined }
}

export interface AiAvailability {
  status: AiStatusResponse
  settings: StoredAiSettings
  key: AiKeyState
  /** The key to call Anthropic with, when there is one that can be used. */
  apiKey: string | null
}

/**
 * Available when switched on, with a usable key, with the readers ready, and
 * far enough under the cap for an answer to start on `model` (the default
 * model unless a person's is given); otherwise the first of those that fails
 * is the reason.
 */
export async function loadAvailability(q: Queryable, config: Config, readerReady: boolean, model: string = AI_MODEL): Promise<AiAvailability> {
  // One after another: `q` may be a transaction's single connection.
  const settings = await loadAiSettings(q)
  const resolved = await resolveApiKey(q, config)
  const spend = await monthSpend(q)
  const capUsd = settings.settings.monthlyCapUsd
  let reason: AiUnavailableReason | undefined
  if (!settings.settings.enabled) reason = 'disabled'
  else if (!resolved.apiKey) reason = 'no-key'
  else if (!readerReady) reason = 'reader-unavailable'
  // The same test the answer loop makes before every call: closer to the cap than one call may cost,
  // no answer could start, so the composer must not offer one.
  else if (spend.spentUsd + minCallWorstCaseUsd(model) > capUsd) reason = 'cap-reached'
  const status: AiStatusResponse = {
    available: reason === undefined,
    model,
    spentUsd: spend.spentUsd,
    capUsd,
    monthStart: spend.monthStart,
  }
  if (reason) status.reason = reason
  return { status, settings, key: resolved.state, apiKey: resolved.apiKey }
}
