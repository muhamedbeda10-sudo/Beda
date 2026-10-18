// ============================================================================
// Report styles (shared/src/reportStyles.ts): how reports look when they
// leave the app. For people given the assistant (403 to anyone else, read
// again on every request): each keeps their own styles and reads the shared
// ones; one with the Configuration permission shares a style with everyone
// and chooses the company's default. The assistant proposes a style from a
// sample (pages of a report, as pictures) or a change put in words; what it
// proposes is not saved until the person saves it.
//
// Every save is a version, kept with who made it; creation, changes, sharing,
// the default and removal are in the audit log (entity ReportStyle) — what
// changed, never the logo's bytes.
// ============================================================================

import { createHash } from 'node:crypto'
import { Router, type Request } from 'express'
import { z } from 'zod'
import { auditEvent } from '@qc/shared/audit'
import {
  BUILTIN_RESOLVED_STYLE,
  REPORT_STYLE_INSTRUCTION_MAX,
  REPORT_STYLE_MAX_PER_OWNER,
  REPORT_STYLE_SAMPLE_MAX_CHARS,
  REPORT_STYLE_SAMPLE_MAX_IMAGES,
  type ReportStyle,
  type ReportStyleDefaultResponse,
  type ReportStyleDraftResponse,
  type ReportStylesResponse,
  type ReportStyleVersionsResponse,
} from '@qc/shared/reportStyles'
import type { AppContext } from '../context'
import { withTransaction } from '../db/pool'
import { ConflictError, HttpError, badRequest, forbidden, notFound } from '../lib/errors'
import { parse } from '../lib/validate'
import { requireUser, userCan, type AuthUser } from '../auth/middleware'
import { auditChanges, auditCreate, auditDelete, writeAudit } from '../audit/service'
import { isGranted, loadAccess } from '../ai/access'
import { factoryDay } from '../ai/prompt'
import { notGranted } from '../ai/refusals'
import { STYLE_DRAFT_SCHEMA, STYLE_DRAFT_SYSTEM, callForPerson, imageBlock, readStyleDraft, structuredParams } from '../reportStyles/aiDrafts'
import { logoSchema, styleNameSchema, styleSpecSchema } from '../reportStyles/styleSchema'
import { countOwnStyles, defaultStyle, findStyle, insertStyle, listStyles, listVersions, updateStyle } from '../reportStyles/styles'

const uuid = z.string().uuid()

const saveSchema = z
  .object({
    name: styleNameSchema,
    spec: styleSpecSchema,
    logoDataUrl: logoSchema,
    version: z.number().int().positive().optional(),
  })
  .strict()

const shareSchema = z.object({ shared: z.boolean() }).strict()
const chooseDefaultSchema = z.object({ styleId: uuid.nullable() }).strict()

const sampleImage = z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/, 'A sample page must be a PNG or JPEG picture.')
const draftSchema = z
  .object({
    images: z.array(sampleImage).max(REPORT_STYLE_SAMPLE_MAX_IMAGES, `Send at most ${REPORT_STYLE_SAMPLE_MAX_IMAGES} pages of a sample.`).optional(),
    spec: styleSpecSchema.optional(),
    instruction: z.string().trim().max(REPORT_STYLE_INSTRUCTION_MAX).optional(),
  })
  .strict()
  .refine((b) => (b.images?.length ?? 0) > 0 || !!b.instruction, 'Send a sample, or say what to change.')
  .refine((b) => (b.images ?? []).reduce((n, i) => n + i.length, 0) <= REPORT_STYLE_SAMPLE_MAX_CHARS, 'The sample pages are too large: send fewer pages or smaller pictures.')

/** A style as the audit log records it: each part of its look, and the logo as a short fingerprint. */
function auditSnapshot(s: Pick<ReportStyle, 'name' | 'spec' | 'logoDataUrl'>): Record<string, unknown> {
  const { spec } = s
  return {
    name: s.name,
    colors: spec.colors,
    font: spec.font,
    orientation: spec.orientation,
    logoPlacement: spec.logo,
    logo: s.logoDataUrl ? `picture ${createHash('sha256').update(s.logoDataUrl).digest('hex').slice(0, 8)}` : 'none',
    header: spec.header,
    docControl: spec.docControl,
    table: spec.table,
    figures: spec.figures,
    numbering: spec.numbering,
    footer: spec.footer,
    approvals: spec.approvals,
  }
}

export function reportStylesRoutes(ctx: AppContext): Router {
  const r = Router()
  const db = ctx.db
  const tz = ctx.config.FACTORY_TIMEZONE

  /** The person asking, given the assistant; 403 when they are not (any more). */
  async function styleUser(req: Request): Promise<AuthUser> {
    const user = requireUser(req)
    if (!isGranted(await loadAccess(db, user.id))) throw notGranted()
    return user
  }

  const mayManage = (user: AuthUser) => userCan(user, 'manage-configuration')
  const audit = (user: AuthUser, id: string) => ({ userId: user.id, userName: user.name, entity: 'ReportStyle', entityId: id })

  r.get('/', async (req, res) => {
    const user = await styleUser(req)
    const styles = await listStyles(db, user.id)
    const body: ReportStylesResponse = { styles, defaultId: styles.find((s) => s.isDefault)?.id ?? null, canManage: mayManage(user) }
    res.json(body)
  })

  /** What answers print in: the company's default, else the built-in look. */
  r.get('/default', async (req, res) => {
    await styleUser(req)
    const body: ReportStyleDefaultResponse = { style: (await defaultStyle(db)) ?? BUILTIN_RESOLVED_STYLE }
    res.json(body)
  })

  /** The company's default chosen (or none: the built-in look). A default is always a shared style. */
  r.put('/default', async (req, res) => {
    const user = await styleUser(req)
    if (!mayManage(user)) throw forbidden("Only someone with the Configuration permission chooses the company's report style.")
    const { styleId } = parse(chooseDefaultSchema, req.body)
    await withTransaction(db, async (tx) => {
      // One at a time: two people choosing at once end with one default, not a unique violation.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('report_styles_default'))`)
      const { rows } = await tx.query<{ id: string }>(`SELECT id FROM report_styles WHERE is_default AND deleted_at IS NULL`)
      const before = rows[0]?.id ?? null
      if (before === styleId) return
      if (styleId) {
        const style = await findStyle(tx, styleId, user.id, true)
        if (!style) throw notFound('That style')
        if (!style.shared) throw badRequest('Share the style with everyone first: the company default is everyone’s to print in.')
      }
      if (before) await tx.query(`UPDATE report_styles SET is_default = false WHERE id = $1`, [before])
      if (styleId) await tx.query(`UPDATE report_styles SET is_default = true WHERE id = $1`, [styleId])
      const at = new Date().toISOString()
      await writeAudit(tx, [
        ...(before ? [auditEvent('update', audit(user, before), at, { field: 'companyDefault', oldValue: 'yes', newValue: 'no' })] : []),
        ...(styleId ? [auditEvent('update', audit(user, styleId), at, { field: 'companyDefault', oldValue: 'no', newValue: 'yes' })] : []),
      ])
    })
    const styles = await listStyles(db, user.id)
    const body: ReportStylesResponse = { styles, defaultId: styles.find((s) => s.isDefault)?.id ?? null, canManage: true }
    res.json(body)
  })

  r.post('/', async (req, res) => {
    const user = await styleUser(req)
    const body = parse(saveSchema, req.body)
    const style = await withTransaction(db, async (tx) => {
      // Counted under the person's own lock: two saves at once cannot pass the limit together.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('report_styles:' || $1))`, [user.id])
      if ((await countOwnStyles(tx, user.id)) >= REPORT_STYLE_MAX_PER_OWNER)
        throw new HttpError(409, 'conflict', `You keep ${REPORT_STYLE_MAX_PER_OWNER} styles already. Delete one you no longer use first.`)
      const saved = await insertStyle(tx, { owner: { id: user.id, name: user.name }, name: body.name, spec: body.spec, logoDataUrl: body.logoDataUrl })
      await auditCreate(tx, audit(user, saved.id))
      return saved
    })
    res.status(201).json(style)
  })

  /** A new version of one's own style; refused when it changed since it was read (version). */
  r.put('/:id', async (req, res) => {
    const user = await styleUser(req)
    const id = parse(uuid, req.params.id)
    const body = parse(saveSchema, req.body)
    if (body.version === undefined) throw badRequest('Send the version you changed.')
    const style = await withTransaction(db, async (tx) => {
      const current = await findStyle(tx, id, user.id, true)
      if (!current) throw notFound('That style')
      if (!current.mine) throw forbidden('Only the person who made a style changes it. Save a copy of it as your own instead.')
      if (current.version !== body.version) throw new ConflictError(current)
      const saved = await updateStyle(tx, current, { name: body.name, spec: body.spec, logoDataUrl: body.logoDataUrl }, { id: user.id, name: user.name }, factoryDay(new Date(), tz))
      await auditChanges(tx, audit(user, id), auditSnapshot(current), auditSnapshot(saved))
      return saved
    })
    res.json(style)
  })

  /** Shared with everyone, or not. The company's default stays shared: another is chosen first. */
  r.post('/:id/share', async (req, res) => {
    const user = await styleUser(req)
    if (!mayManage(user)) throw forbidden('Only someone with the Configuration permission shares styles with everyone.')
    const id = parse(uuid, req.params.id)
    const { shared } = parse(shareSchema, req.body)
    const style = await withTransaction(db, async (tx) => {
      const current = await findStyle(tx, id, user.id, true)
      if (!current) throw notFound('That style')
      if (current.shared === shared) return current
      if (!shared && current.isDefault) throw new HttpError(409, 'conflict', "This is the company's default style. Choose another default (or none) before you stop sharing it.")
      await tx.query(`UPDATE report_styles SET shared = $2 WHERE id = $1`, [id, shared])
      await writeAudit(tx, [auditEvent('update', audit(user, id), new Date().toISOString(), { field: 'shared', oldValue: String(current.shared), newValue: String(shared) })])
      return (await findStyle(tx, id, user.id))!
    })
    res.json(style)
  })

  r.get('/:id/versions', async (req, res) => {
    const user = await styleUser(req)
    const id = parse(uuid, req.params.id)
    if (!(await findStyle(db, id, user.id))) throw notFound('That style')
    const body: ReportStyleVersionsResponse = { versions: await listVersions(db, id) }
    res.json(body)
  })

  /**
   * One's own style removed (the record and its versions stay). Reports that
   * printed in it print in the company's default; if it was the default,
   * there is none until another is chosen.
   */
  r.delete('/:id', async (req, res) => {
    const user = await styleUser(req)
    const id = parse(uuid, req.params.id)
    await withTransaction(db, async (tx) => {
      const current = await findStyle(tx, id, user.id, true)
      if (!current) throw notFound('That style')
      if (!current.mine) throw forbidden('Only the person who made a style deletes it.')
      await tx.query(`UPDATE report_styles SET deleted_at = now(), deleted_by_id = $2, is_default = false WHERE id = $1`, [id, user.id])
      await auditDelete(tx, audit(user, id))
    })
    res.status(204).end()
  })

  /**
   * A style the assistant proposes, from pages of a sample and/or a change in
   * words, checked like anything typed; not saved. Counted with the person's
   * questions, after the same checks.
   */
  r.post('/draft', async (req, res) => {
    const user = await styleUser(req)
    const body = parse(draftSchema, req.body)
    const images = body.images ?? []
    const what = images.length > 0 ? 'Reading the sample' : 'Changing the style'
    const params = structuredParams({
      job: 'report-style',
      system: STYLE_DRAFT_SYSTEM,
      schema: STYLE_DRAFT_SCHEMA,
      content: [
        ...images.map(imageBlock),
        { type: 'text', text: JSON.stringify({ sampleImages: images.length, currentStyle: body.spec ?? null, instruction: body.instruction || null }) },
      ],
    })
    const raw = await callForPerson(ctx, user.id, params, what)
    const draft: ReportStyleDraftResponse = readStyleDraft(raw, body.spec)
    res.json(draft)
  })

  return r
}
