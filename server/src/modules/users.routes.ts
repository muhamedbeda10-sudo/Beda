import { Router } from 'express'
import { z } from 'zod'
import {
  ADMIN_PLUS,
  PERMISSION_IDS,
  PERMISSION_INFO,
  effectivePermissions,
  isPermission,
  permissionsBeyond,
  type Permission,
  type PermissionOverride,
  type RolePermissionsResponse,
} from '@qc/shared/permissions'
import { ROLES, type DirectoryUser, type ManagedUser, type Role } from '@qc/shared/types'
import type { AppContext } from '../context'
import { withTransaction, PG, pgCode, type Queryable } from '../db/pool'
import { badRequest, duplicate, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password'
import { requireAnyPermission, requirePermission, requireUser, type AuthUser } from '../auth/middleware'
import { loadRolePermissions } from '../auth/permissions'
import { listManagedUsers, loadManagedUser } from '../auth/profile'
import { auditChanges, auditCreate, auditDelete } from '../audit/service'
import { RESERVED_OWNER_NAME, isReservedForAiOwner } from '../ai/owner'
import { usernameSchema } from './auth.routes'

const uuid = z.string().uuid()
const roleSchema = z.enum(ROLES as unknown as [Role, ...Role[]])
const permissionSchema = z.string().refine(isPermission, 'Not one of the permissions.').transform((v) => v as Permission)

const createSchema = z.object({
  username: usernameSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  name: z.string().trim().min(1).max(120),
  role: roleSchema,
})

const updateSchema = z
  .object({
    username: usernameSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update.')

const rolePermissionsSchema = z.object({ permissions: z.array(permissionSchema).max(PERMISSION_IDS.length * 2) }).strict()

const overridesSchema = z
  .object({
    overrides: z.array(z.object({ permission: permissionSchema, granted: z.boolean() }).strict()).max(PERMISSION_IDS.length),
  })
  .strict()
  .refine((b) => new Set(b.overrides.map((o) => o.permission)).size === b.overrides.length, 'Each permission once.')

/** Serialises changes to the roles' sets: two administrators saving at once do not interleave. */
const ROLE_LOCK_KEY = 8_811_014

const NOT_ADMIN_PLUS = `The ${ADMIN_PLUS} account is changed by its owner alone.`

/**
 * §14 — accounts, and what each role and each person may open and do. For
 * whoever may open Users (administrators by default), with these limits so
 * nobody gives more than they hold:
 *
 *   • ADMIN+ (the AI assistant's owner) is changed by nobody else — not its
 *     name, role, password, switch or permissions, and it cannot be removed;
 *     it holds every permission whatever is set;
 *   • nobody changes their own role, switch or permissions;
 *   • one may manage only an account whose permissions one holds oneself, and
 *     give only permissions one holds — a role, a role's set, an override;
 *   • the administrators' own set is ADMIN+'s alone to change.
 *
 * Removing an account is a soft delete: the row stays so audit entries and
 * inspections keep pointing at the person who made them, but the account
 * leaves the list, cannot sign in, and its username is free for someone else.
 */
export function usersRoutes(ctx: AppContext): Router {
  const r = Router()

  /** The people, by name, for the screens that pick or name them: a notice's audience, the dashboard's inspectors. */
  r.get('/directory', requireAnyPermission('manage-users', 'manage-notices', 'view-dashboard'), async (_req, res) => {
    const { rows } = await ctx.db.query<DirectoryUser>(
      `SELECT id, username, name, role, is_active AS "isActive" FROM users WHERE deleted_at IS NULL AND NOT is_system ORDER BY name, username`,
    )
    res.json(rows)
  })

  r.use(requirePermission('manage-users'))

  /** The editor, as read on this request: what they hold, and whether they are ADMIN+. */
  const editorOf = (user: AuthUser) => ({ id: user.id, name: user.name, role: user.role, adminPlus: user.adminPlus, held: [...user.permissions] })
  type Editor = ReturnType<typeof editorOf>

  /** One may give only what one holds (ADMIN+ holds everything). */
  const assertHolds = (editor: Editor, wanted: readonly Permission[], what: string) => {
    if (editor.adminPlus) return
    const beyond = permissionsBeyond(editor.held, wanted)
    if (beyond.length > 0) {
      throw forbidden(`${what} would give ${namesOf(beyond)}, which you do not hold yourself.`)
    }
  }

  /** One manages only an account that is not ADMIN+ and whose permissions one holds. */
  const assertManages = (editor: Editor, target: ManagedUser) => {
    if (target.adminPlus && target.id !== editor.id) throw forbidden(NOT_ADMIN_PLUS)
    assertHolds(editor, target.permissions, `Changing ${target.name}`)
  }

  r.get('/', async (_req, res) => {
    const body: ManagedUser[] = await listManagedUsers(ctx.db)
    res.json(body)
  })

  r.post('/', async (req, res) => {
    const editor = editorOf(requireUser(req))
    const body = parse(createSchema, req.body)
    const passwordHash = await hashPassword(body.password)
    const user = await withTransaction(ctx.db, async (tx) => {
      assertHolds(editor, (await loadRolePermissions(tx))[body.role], `The ${body.role} role`)
      if (await isReservedForAiOwner(tx, ctx.config, body.username)) throw duplicate(RESERVED_OWNER_NAME)
      let id: string
      try {
        id = (
          await tx.query<{ id: string }>(`INSERT INTO users (username, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [
            body.username,
            body.name,
            body.role,
            passwordHash,
          ])
        ).rows[0].id
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This username is already taken.')
        throw e
      }
      await auditCreate(tx, { userId: editor.id, userName: editor.name, entity: 'User', entityId: id })
      return (await loadManagedUser(tx, id))!
    })
    res.status(201).json(user)
  })

  r.patch('/:id', async (req, res) => {
    const editor = editorOf(requireUser(req))
    const body = parse(updateSchema, req.body)
    const id = parse(uuid, req.params.id)

    const user = await withTransaction(ctx.db, async (tx) => {
      const before = await lockUser(tx, id)
      assertManages(editor, before)
      if (body.username !== undefined && body.username !== before.username.toLowerCase() && (await isReservedForAiOwner(tx, ctx.config, body.username))) {
        throw duplicate(RESERVED_OWNER_NAME)
      }
      const nextRole = body.role ?? before.role
      const nextActive = body.isActive ?? before.isActive
      if (id === editor.id && (nextRole !== before.role || !nextActive)) {
        throw badRequest('You cannot change your own role or deactivate yourself.')
      }
      if (before.role === 'admin' && before.isActive && (nextRole !== 'admin' || !nextActive)) {
        await assertAnotherActiveAdmin(tx, id)
      }
      if (nextRole !== before.role) {
        // Their permissions under the new role, their own overrides kept: none beyond the editor's.
        const roles = await loadRolePermissions(tx)
        assertHolds(editor, effectivePermissions(roles[nextRole], before.overrides), `The ${nextRole} role`)
      }

      const passwordHash = body.password ? await hashPassword(body.password) : null
      try {
        await tx.query(
          `UPDATE users
              SET username = COALESCE($2, username),
                  name = COALESCE($3, name),
                  role = COALESCE($4, role),
                  is_active = COALESCE($5, is_active),
                  password_hash = COALESCE($6, password_hash)
            WHERE id = $1`,
          [id, body.username ?? null, body.name ?? null, body.role ?? null, body.isActive ?? null, passwordHash],
        )
      } catch (e) {
        if (pgCode(e) === PG.UNIQUE_VIOLATION) throw duplicate('This username is already taken.')
        throw e
      }
      const after = (await loadManagedUser(tx, id))!

      if (!after.isActive) {
        await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      }
      const ctxAudit = { userId: editor.id, userName: editor.name, entity: 'User', entityId: id }
      await auditChanges(
        tx,
        ctxAudit,
        { username: before.username, name: before.name, role: before.role, isActive: before.isActive },
        { username: after.username, name: after.name, role: after.role, isActive: after.isActive },
      )
      if (passwordHash && id !== editor.id) {
        await auditChanges(tx, ctxAudit, { password: '' }, { password: '(reset by administrator)' })
        await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      } else if (passwordHash) {
        await auditChanges(tx, ctxAudit, { password: '' }, { password: '(changed)' })
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
    const editor = editorOf(requireUser(req))
    const id = parse(uuid, req.params.id)
    if (id === editor.id) throw badRequest('You cannot remove your own account.')

    await withTransaction(ctx.db, async (tx) => {
      const before = await lockUser(tx, id)
      assertManages(editor, before)
      if (before.role === 'admin' && before.isActive) await assertAnotherActiveAdmin(tx, id)
      // Its own differences from its role go with it: the account is no longer one to give permissions to.
      await tx.query(`DELETE FROM user_permissions WHERE user_id = $1`, [id])
      await tx.query(`UPDATE users SET is_active = false, deleted_at = now(), deleted_by_id = $2 WHERE id = $1`, [id, editor.id])
      await tx.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])
      await auditDelete(tx, { userId: editor.id, userName: editor.name, entity: 'User', entityId: id })
    })
    res.status(204).end()
  })

  // ---- What each role may open and do ------------------------------------------------

  r.get('/roles', async (req, res) => {
    const editor = editorOf(requireUser(req))
    const body: RolePermissionsResponse = { roles: await loadRolePermissions(ctx.db), editable: editableRoles(editor) }
    res.json(body)
  })

  /** A role's set, all of it: what everyone of the role holds, less their own overrides. */
  r.put('/roles/:role', async (req, res) => {
    const editor = editorOf(requireUser(req))
    const role = parse(roleSchema, req.params.role)
    const wanted = PERMISSION_IDS.filter((p) => parse(rolePermissionsSchema, req.body).permissions.includes(p))
    if (!editableRoles(editor).includes(role)) {
      throw forbidden(role === 'admin' ? `The administrators' permissions are changed by ${ADMIN_PLUS} alone.` : 'You cannot change the permissions of your own role.')
    }
    const body = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [ROLE_LOCK_KEY])
      const before = (await loadRolePermissions(tx))[role]
      const added = wanted.filter((p) => !before.includes(p))
      assertHolds(editor, added, 'This')
      await tx.query(`DELETE FROM role_permissions WHERE role = $1`, [role])
      await tx.query(`INSERT INTO role_permissions (role, permission) SELECT $1, unnest($2::text[])`, [role, wanted])
      await auditChanges(
        tx,
        { userId: editor.id, userName: editor.name, entity: 'RolePermissions', entityId: role },
        permissionSnapshot(before),
        permissionSnapshot(wanted),
      )
      const out: RolePermissionsResponse = { roles: await loadRolePermissions(tx), editable: editableRoles(editor) }
      return out
    })
    res.json(body)
  })

  // ---- A person's own differences from their role ------------------------------------------

  /**
   * The person's overrides, all of them. Only differences from their role are
   * kept: an override that says what the role says already is dropped, so the
   * person follows their role's later changes in it.
   */
  r.put('/:id/permissions', async (req, res) => {
    const editor = editorOf(requireUser(req))
    const id = parse(uuid, req.params.id)
    const { overrides } = parse(overridesSchema, req.body)
    if (id === editor.id) throw badRequest('You cannot change your own permissions.')

    const user = await withTransaction(ctx.db, async (tx) => {
      const before = await lockUser(tx, id)
      assertManages(editor, before)
      const role = before.rolePermissions
      const kept: PermissionOverride[] = PERMISSION_IDS.flatMap((p) => {
        const o = overrides.find((x) => x.permission === p)
        return o && o.granted !== role.includes(p) ? [{ permission: p, granted: o.granted }] : []
      })
      assertHolds(
        editor,
        kept.filter((o) => o.granted).map((o) => o.permission),
        'This',
      )
      await tx.query(`DELETE FROM user_permissions WHERE user_id = $1`, [id])
      if (kept.length > 0) {
        await tx.query(
          `INSERT INTO user_permissions (user_id, permission, granted, updated_by_id, updated_by_name)
           SELECT $1, x.permission, x.granted, $3, $4 FROM jsonb_to_recordset($2::jsonb) AS x(permission text, granted boolean)`,
          [id, JSON.stringify(kept), editor.id, editor.name],
        )
      }
      const words = (list: readonly PermissionOverride[]) =>
        Object.fromEntries(list.map((o) => [`permission: ${PERMISSION_INFO[o.permission].name}`, o.granted ? 'given' : 'taken away']))
      const was = words(before.overrides)
      const now = words(kept)
      // A permission back to its role's reads "as the role" rather than vanishing from the trail.
      for (const k of Object.keys(was)) now[k] ??= 'as the role'
      for (const k of Object.keys(now)) was[k] ??= 'as the role'
      await auditChanges(tx, { userId: editor.id, userName: editor.name, entity: 'User', entityId: id }, was, now)
      return (await loadManagedUser(tx, id))!
    })
    res.json(user)
  })

  return r
}

/** The roles whose sets an editor may change: not the administrators' (ADMIN+'s alone), not their own. */
function editableRoles(editor: { role: Role; adminPlus: boolean }): Role[] {
  if (editor.adminPlus) return [...ROLES]
  return ROLES.filter((r) => r !== 'admin' && r !== editor.role)
}

function namesOf(list: readonly Permission[]): string {
  const names = list.map((p) => `“${PERMISSION_INFO[p].name}”`)
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A set as the audit trail compares it: each permission on or off. */
function permissionSnapshot(list: readonly Permission[]): Record<string, string> {
  return Object.fromEntries(PERMISSION_IDS.map((p) => [PERMISSION_INFO[p].name, list.includes(p) ? 'on' : 'off']))
}

/** The live account, locked for the rest of the transaction. The system sender (§21) is no account to administer. */
async function lockUser(tx: Queryable, id: string): Promise<ManagedUser & { rolePermissions: Permission[] }> {
  const m = await loadManagedUser(tx, id, true)
  if (!m) throw notFound('That user')
  const roles = await loadRolePermissions(tx)
  return { ...m, rolePermissions: roles[m.role] }
}

/** Somebody must always be able to reach Users: refuse to lose the last active admin. */
async function assertAnotherActiveAdmin(tx: Queryable, exceptId: string): Promise<void> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND deleted_at IS NULL AND NOT is_system AND id <> $1`,
    [exceptId],
  )
  if (rows[0].n === 0) throw badRequest('At least one active administrator must remain.')
}
