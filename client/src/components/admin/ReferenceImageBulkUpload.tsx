import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ImagePlus, Loader2, Trash2, UploadCloud } from 'lucide-react'
import { Badge, Button, Input, Modal } from '@/components/ui'
import { uploadImage } from '@/services/uploadImage'
import { ImageRejected } from '@/services/imageStore'
import { createMaster } from '@/services/mutations'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Load many reference photos at once, one master-data row per photo. The item
 * code is read from the file name the way the old system exported it —
 * `XL_UP_NP__2026-04-07T13-07-01-220Z.PNG` belongs to item `XL.UP.NP.` — and
 * can be corrected by hand before anything is uploaded.
 *
 * Each photo is uploaded first and its row written second (§9.5), one after
 * another, so a failure part-way leaves every earlier photo complete and the
 * failed one marked for a retry; nothing is half-written.
 */
export function ReferenceImageBulkUpload({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<PendingImage[]>([])
  const [running, setRunning] = useState(false)
  const [dragging, setDragging] = useState(false)

  const pending = rows.filter((r) => r.status !== 'done')
  const ready = pending.filter((r) => r.itemCode.trim() !== '')
  const done = rows.filter((r) => r.status === 'done').length

  function addFiles(list: FileList | File[] | null) {
    if (!list) return
    const files = Array.from(list).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
    setRows((cur) => [
      ...cur,
      ...files.map((file) => ({ key: `${file.name}-${file.size}-${file.lastModified}`, file, itemCode: itemCodeFromFilename(file.name), status: 'pending' as const })),
    ])
    if (fileRef.current) fileRef.current.value = ''
  }

  function patch(key: string, p: Partial<PendingImage>) {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }

  async function uploadAll() {
    setRunning(true)
    try {
      for (const row of rows) {
        if (row.status === 'done' || row.itemCode.trim() === '') continue
        patch(row.key, { status: 'uploading', error: undefined })
        try {
          const asset = await uploadImage(row.file, {})
          await createMaster(queryClient, 'item-reference-images', {
            itemCode: row.itemCode.trim(),
            item: '',
            imageId: asset.id,
            caption: row.file.name,
          })
          patch(row.key, { status: 'done' })
        } catch (e) {
          patch(row.key, {
            status: 'failed',
            error: e instanceof ImageRejected || e instanceof ApiError ? e.message : 'Upload failed.',
          })
        }
      }
    } finally {
      setRunning(false)
    }
  }

  function close() {
    if (running) return
    setRows([])
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Upload reference images in bulk"
      icon={<ImagePlus className="h-5 w-5" />}
      size="lg"
      footer={
        <>
          <Button className="min-h-[48px]" onClick={close} disabled={running}>
            {done > 0 && pending.length === 0 ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" className="min-h-[48px]" onClick={() => void uploadAll()} disabled={running || ready.length === 0}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            {running ? 'Uploading…' : `Upload ${ready.length} ${ready.length === 1 ? 'photo' : 'photos'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addFiles(e.dataTransfer.files)
          }}
          className={cn(
            'rounded-2xl border-2 border-dashed p-4 text-center transition-colors',
            dragging ? 'border-brand-400 bg-brand-50/60 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700',
          )}
        >
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Drop the photos here, or{' '}
            <button type="button" className="font-semibold text-brand-600 underline-offset-2 hover:underline" onClick={() => fileRef.current?.click()}>
              choose files
            </button>
            . The item code is read from each file name (
            <code className="text-xs">XL_UP_NP__…​.PNG → XL.UP.NP.</code>) and can be edited below.
          </p>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        </div>

        {rows.length > 0 && (
          <div className="max-h-[46vh] overflow-y-auto rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-bold">File</th>
                  <th className="px-3 py-2 font-bold">Item code</th>
                  <th className="px-3 py-2 text-right font-bold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="max-w-[14rem] truncate px-3 py-2 align-middle" title={r.file.name}>
                      {r.file.name}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <Input
                        value={r.itemCode}
                        disabled={r.status === 'done' || running}
                        onChange={(e) => patch(r.key, { itemCode: e.target.value })}
                        className={cn('min-h-[40px]', r.itemCode.trim() === '' && 'border-rose-400')}
                        placeholder="Item code"
                      />
                    </td>
                    <td className="px-3 py-2 text-right align-middle">
                      <span className="inline-flex items-center gap-2">
                        {r.status === 'pending' && r.itemCode.trim() === '' && <Badge tone="red">needs a code</Badge>}
                        {r.status === 'pending' && r.itemCode.trim() !== '' && <Badge tone="neutral">ready</Badge>}
                        {r.status === 'uploading' && <Loader2 className="h-4 w-4 animate-spin text-brand-500" />}
                        {r.status === 'done' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                        {r.status === 'failed' && (
                          <span className="inline-flex items-center gap-1 text-xs text-rose-600" title={r.error}>
                            <AlertCircle className="h-4 w-4" /> {r.error ?? 'failed'}
                          </span>
                        )}
                        {r.status !== 'done' && !running && (
                          <button
                            type="button"
                            onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}
                            className="rounded p-1 text-slate-300 hover:text-rose-500"
                            aria-label={`Remove ${r.file.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {done > 0 && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            {done} {done === 1 ? 'photo' : 'photos'} uploaded and attached.
          </p>
        )}
      </div>
    </Modal>
  )
}

interface PendingImage {
  key: string
  file: File
  itemCode: string
  status: 'pending' | 'uploading' | 'done' | 'failed'
  error?: string
}

/**
 * The item code encoded in an exported file name. The old system wrote the
 * code with its dots turned into underscores, then an underscore and an ISO
 * timestamp: `XL_UP_NP_` + `_` + `2026-04-07T13-07-01-220Z` for item
 * `XL.UP.NP.` (the trailing dot is why the separator looks doubled). A file
 * name without a timestamp yields its stem with underscores turned back into
 * dots.
 */
export function itemCodeFromFilename(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '')
  const stamped = stem.match(/^(.*)_\d{4}-\d{2}-\d{2}T[\dA-Za-z-]+$/)
  const prefix = stamped ? stamped[1] : stem
  return prefix.replace(/_/g, '.').trim()
}
