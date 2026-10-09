import { Router } from 'express'
import { z } from 'zod'
import { ROLES, type UserProfile } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { badRequest, duplicate, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password'
import { requireRole, requireUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { aiOwnerAccount } from '../ai/owner'
import { USER_COLUMNS, usernameSchema } from './auth.routes'

const uuid = z.string().uuid()

const createSchema = z.object({
  username: usernameSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES as unknown as [string, ...string[]]),
})

const updateSchema = z
  .object({
    username: usernameSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLES as unknown as [string, ...string[]]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update.')

/**
 * Account administration — admin only. Removing an account is a soft delete:
 * the row stays so audit entries and inspections keep pointing at the person
 * who made them, but the account leaves the list, cannot sign in, and its
 * username is free for someone else.
 */
export function usersRoutes(ctx: AppContext): Router {
  const r = Router()
  r.use(requireRole('admin'))

  r.get('/', async (_req, res) => {
    const { rows } = await ctx.db.query<UserProfile>(`SELECT ${USER_COLUMNS} FROM users WHERE deleted_at IS NULL ORDER BY name, username`)
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
            `INSERT INTO users (username, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
            [body.username, body.name, body.role, passwordHash],
          )
        ).rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This username is already taken.')
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
    const id = parse(uuid, req.params.id)
    // Whoever sets a password holds the account: the AI assistant's owner's is theirs alone to set (§20),
    // deactivated or not. Read before the transaction, which locks the row a first pin would wait on.
    const ownerAccount = body.password && id !== admin.id ? await aiOwnerAccount(ctx.db, ctx.config) : null

    const user = await withTransaction(ctx.db, async (tx) => {
      const before = await lockUser(tx, id)
      if (ownerAccount === id) throw forbidden(`Only ${before.name} can change this account's password.`)

      const nextRole = body.role ?? before.role
      const nextActive = body.isActive ?? before.isActive
      if (id === admin.id && (nextRole !== 'admin' || !nextActive)) {
        throw badRequest('You cannot remove your own admin access or deactivate yourself.')
      }
      if (before.role === 'admin' && before.isActive && (nextRole !== 'admin' || !nextActive)) {
        await assertAnotherActiveAdmin(tx, id)
      }

      const passwordHash = body.password ? await hashPassword(body.password) : null
      let after: UserProfile
      try {
        after = (
          await tx.query<UserProfile>(
            `UPDATE users
                SET username = COALESCE($2, username),
                    name = COALESCE($3, name),
                    role = COALESCE($4, role),
                    is_active = COALESCE($5, is_active),
                    password_hash = COALESCE($6, password_hash)
              WHERE id = $1
              RETURNING ${USER_COLUMNS}`,
            [id, body.username ?? null, body.name ?? null, body.role ?? null, body.isActive ?? null, passwordHash],
          )
        ).rows[0]
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This username is already taken.')
        throw e
      }

      if (!after.isActive) {
        await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      }
      const ctxAudit = { userId: admin.id, userName: admin.name, entity: 'User', entityId: id }
      await auditChanges(
        tx,
        ctxAudit,
        { username: before.username, name: before.name, role: before.role, isActive: before.isActive },
        { username: after.username, name: after.name, role: after.role, isActive: after.isActive },
      )
      if (passwordHash) {
        await auditChanges(tx, ctxAudit, { password: '' }, { password: '(reset by administrator)' })
        await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      }
      return after
    })
    res.json(user)
  })

  /**
   * Remove an account. The row is kept (inspections and audit entries point at
   * it) but marked deleted: it leaves the list, every signed-in device is
   * signed out, and the username may be given to someone else.
   */
  r.delete('/:id', async (req, res) => {
    const admin = requireUser(req)
    const id = parse(uuid, req.params.id)
    if (id === admin.id) throw badRequest('You cannot remove your own account.')

    await withTransaction(ctx.db, async (tx) => {
      const before = await lockUser(tx, id)
      if (before.role === 'admin' && before.isActive) await assertAnotherActiveAdmin(tx, id)
      await tx.query(
        `UPDATE users SET is_active = false, deleted_at = now(), deleted_by_id = $2 WHERE id = $1`,
        [id, admin.id],
      )
      await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      await auditDelete(tx, { userId: admin.id, userName: admin.name, entity: 'User', entityId: id })
    })
    res.status(204).end()
  })

  return r
}

/** The live account, locked for the rest of the transaction. */
async function lockUser(tx: Queryable, id: string): Promise<UserProfile> {
  const { rows } = await tx.query<UserProfile>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])
  if (!rows[0]) throw notFound('That user')
  return rows[0]
}

/** Somebody must always be able to reach Users: refuse to lose the last active admin. */
async function assertAnotherActiveAdmin(tx: Queryable, exceptId: string): Promise<void> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND deleted_at IS NULL AND id <> $1`,
    [exceptId],
  )
  if (rows[0].n === 0) throw badRequest('At least one active administrator must remain.')
}
