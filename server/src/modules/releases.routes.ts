// ============================================================================
// §18 — What's new. The notes themselves live in the shared package; the API
// only remembers how far each administrator has read, and only ever moves
// that mark forward.
// ============================================================================

import { Router } from 'express'
import { z } from 'zod'
import type { MarkReleaseSeenRequest, ReleaseStateResponse } from '@qc/shared/api'
import { isReleaseId } from '@qc/shared/releases'
import type { AppContext } from '../context'
import { badRequest } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireCapability, requireUser } from '../auth/middleware'

const seenSchema = z.object({ releaseId: z.string().trim().min(1).max(40) })

export function releasesRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  // The prompt is for administrators: they are the ones who asked for it.
  r.use(requireCapability('manage-admin-data'))

  r.get('/state', async (req, res) => {
    const user = requireUser(req)
    const { rows } = await db.query<{ lastSeenReleaseId: string | null }>(`SELECT last_seen_release_id AS "lastSeenReleaseId" FROM users WHERE id = $1`, [user.id])
    const body: ReleaseStateResponse = { lastSeenReleaseId: rows[0]?.lastSeenReleaseId ?? null }
    res.json(body)
  })

  r.post('/seen', async (req, res) => {
    const user = requireUser(req)
    const body = parse(seenSchema, req.body) as MarkReleaseSeenRequest
    if (!isReleaseId(body.releaseId)) throw badRequest('That release is not in the notes.')
    // Forward only: dismissing an older note never hides a newer one again.
    const { rows } = await db.query<{ lastSeenReleaseId: string | null }>(
      `UPDATE users SET last_seen_release_id = CASE WHEN last_seen_release_id IS NULL OR last_seen_release_id < $2 THEN $2 ELSE last_seen_release_id END
        WHERE id = $1 RETURNING last_seen_release_id AS "lastSeenReleaseId"`,
      [user.id, body.releaseId],
    )
    const out: ReleaseStateResponse = { lastSeenReleaseId: rows[0]?.lastSeenReleaseId ?? null }
    res.json(out)
  })

  return r
}
