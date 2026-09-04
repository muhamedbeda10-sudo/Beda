import { Router } from 'express'
import { z } from 'zod'
import { ROLES, type UserProfile } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode } from '../db/pool'
import { badRequest, duplicate, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password'
import { requireRole, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate } from '../audit/service'
import { USER_COLUMNS } from './auth.routes'

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES as unknown as [string, ...string[]]),
})

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLES as unknown as [string, ...string[]]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update.')

/** Account administration — admin only. Accounts are deactivated, never deleted:
 *  audit entries and inspections keep pointing at the person who made them. */
export function usersRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requireRole('admin'))

  r.get('/', async (_req, res) => {
    const { rows } = await ctx.db.query<UserProfile>(`SELECT ${USER_COLUMNS} FROM users ORDER BY name, email`)
    res.json(rows)
  })

  r.post('/', async (req, res) => {
    const admin = requireUser(req)
    const body = parse(createSchema, req.body)
    const passwordHash = await hashPassword(body.password)
    const user = await withTransaction(ctx.db, async (tx) => {
      let row: UserProfile
      try {
        row = (
          await tx.query<UserProfile>(
            `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
            [body.email, body.name, body.role, passwordHash],
          )
        ).rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This email is already registered.')
        throw e
      }
      await auditCreate(tx, { userId: admin.id, userName: admin.name, entity: 'User', entityId: row.id })
      return row
    })
    res.status(201).json(user)
  })

  r.patch('/:id', async (req, res) => {
    const admin = requireUser(req)
    const body = parse(updateSchema, req.body)
    const id = req.params.id

    const user = await withTransaction(ctx.db, async (tx) => {
      const before = (await tx.query<UserProfile>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      if (!before) throw notFound('That user')

      const nextRole = body.role ?? before.role
      const nextActive = body.isActive ?? before.isActive
      if (id === admin.id && (nextRole !== 'admin' || !nextActive)) {
        throw badRequest('You cannot remove your own admin access or deactivate yourself.')
      }
      if (before.role === 'admin' && before.isActive && (nextRole !== 'admin' || !nextActive)) {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1`,
          [id],
        )
        if (rows[0].n === 0) throw badRequest('At least one active administrator must remain.')
      }

      const passwordHash = body.password ? await hashPassword(body.password) : null
      const after = (
        await tx.query<UserProfile>(
          `UPDATE users
              SET name = COALESCE($2, name),
                  role = COALESCE($3, role),
                  is_active = COALESCE($4, is_active),
                  password_hash = COALESCE($5, password_hash)
            WHERE id = $1
            RETURNING ${USER_COLUMNS}`,
          [id, body.name ?? null, body.role ?? null, body.isActive ?? null, passwordHash],
        )
      ).rows[0]

      if (!after.isActive) {
        await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      }
      const ctxAudit = { userId: admin.id, userName: admin.name, entity: 'User', entityId: id }
      await auditChanges(
        tx,
        ctxAudit,
        { name: before.name, role: before.role, isActive: before.isActive },
        { name: after.name, role: after.role, isActive: after.isActive },
      )
      if (passwordHash) {
        await auditChanges(tx, ctxAudit, { password: '' }, { password: '(reset by administrator)' })
        await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      }
      return after
    })
    res.json(user)
  })

  return r
}
