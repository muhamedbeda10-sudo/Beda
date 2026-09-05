// ============================================================================
// The factory's own controlled documents, shipped with the API and loaded
// into an EMPTY work-instructions table on first start, so the wizard offers
// them without anyone having to upload the set by hand. Once the table has a
// row this never runs again: administrators own the documents from then on.
// ============================================================================

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppContext } from '../context'
import { storeWorkInstruction } from '../modules/workInstructions.routes'

interface ManifestEntry {
  code: string
  title: string
  issueNo: string
  issueDate?: string
  process: string
  step: string
  sortOrder?: number
  file: string
}

export function defaultSeedDir(): string {
  // Next to `src` while developing, next to `dist` when bundled.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../seed/work-instructions'), path.resolve(here, '../seed/work-instructions')]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

export async function seedWorkInstructionsIfEmpty(ctx: AppContext, dir = defaultSeedDir()): Promise<number> {
  const manifest = path.join(dir, 'manifest.json')
  if (!existsSync(manifest)) return 0
  const { rows } = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM work_instructions')
  if (rows[0].n > 0) return 0
  const entries = JSON.parse(await readFile(manifest, 'utf8')) as ManifestEntry[]
  let loaded = 0
  for (const e of entries) {
    const bytes = await readFile(path.join(dir, e.file))
    await storeWorkInstruction(ctx, {
      code: e.code,
      title: e.title,
      issueNo: e.issueNo,
      issueDate: e.issueDate ?? null,
      process: e.process,
      step: e.step,
      sortOrder: e.sortOrder ?? 0,
      originalFilename: e.file,
      bytes,
      uploadedBy: { id: null, name: 'System (shipped set)' },
    })
    loaded += 1
  }
  return loaded
}
