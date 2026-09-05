// ============================================================================
// Item reference images, shown on the Dimensions step (§7).
// ============================================================================

import { useCallback, useState } from 'react'
import { Image as ImageIcon, UploadCloud } from 'lucide-react'
import { Button, Field, Input } from '@/components/ui'
import { ImagePicker } from '@/components/inspection/ImagePicker'
import { ReferenceImageBulkUpload } from '@/components/admin/ReferenceImageBulkUpload'
import { useMaster } from '@/services/queries'
import { can } from '@/domain'
import { MasterDataPanel, MachineSelect, numberOrNull, requireNumber, requireText } from '@/components/admin/MasterDataPanel'
import { type ItemReferenceImage } from '@qc/shared/types'

interface RefImageDraft {
  itemCode: string
  item: string
  caption: string
  imageId: string
}

export function ReferenceImagesSection() {
  const { data: rows = [], isLoading: loading } = useMaster('item-reference-images')
  const [bulkOpen, setBulkOpen] = useState(false)

  const sort = useCallback(
    (a: ItemReferenceImage, b: ItemReferenceImage) =>
      a.itemCode.localeCompare(b.itemCode, undefined, { numeric: true }) || (a.caption ?? '').localeCompare(b.caption ?? ''),
    [],
  )

  return (
    <MasterDataPanel<'item-reference-images', RefImageDraft>
      title="Item reference images"
      description="The approved photo an inspector compares the real part against."
      hint="Keyed by item code. These images are shown to inspectors on the Dimensions step, so they can compare the part in front of them with the reference while measuring it."
      icon={<ImageIcon className="h-5 w-5" />}
      kind='item-reference-images'
      rows={rows}
      loading={loading}
      sort={sort}
      addLabel="Add reference"
      extraActions={
        <>
          <Button className="min-h-[48px]" onClick={() => setBulkOpen(true)}>
            <UploadCloud className="h-4 w-4" /> Upload many
          </Button>
          <ReferenceImageBulkUpload open={bulkOpen} onClose={() => setBulkOpen(false)} />
        </>
      }
      emptyHint="Attach a reference photo to an item so inspectors have something to compare against, or upload a folder of photos named after their item codes."
      minTableWidth="min-w-[34rem]"
      columns={[
        { key: 'itemCode', label: 'Item code', render: (r) => <span className="font-semibold">{r.itemCode}</span> },
        { key: 'item', label: 'Item', render: (r) => r.item || '—' },
        { key: 'caption', label: 'Caption', render: (r) => <span dir="auto">{r.caption || '—'}</span> },
        {
          key: 'image',
          label: 'Image',
          render: (r) => (
            <ImagePicker imageIds={r.imageId ? [r.imageId] : []} onChange={() => undefined} readOnly />
          ),
        },
      ]}
      describe={(r) => `${r.itemCode}${r.caption ? ` · ${r.caption}` : ''}`}
      newDraft={() => ({ itemCode: '', item: '', caption: '', imageId: '' })}
      toDraft={(r) => ({ itemCode: r.itemCode, item: r.item ?? '', caption: r.caption ?? '', imageId: r.imageId })}
      validate={(d) =>
        requireText(d.itemCode, 'Item code') ?? (d.imageId.trim() ? null : 'Choose a reference image.')
      }
      toRecord={(d) => ({
        itemCode: d.itemCode.trim(),
        item: d.item.trim(),
        imageId: d.imageId,
        caption: d.caption.trim() || undefined,
      })}
      renderForm={(d, patch) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Item code">
              <Input value={d.itemCode} onChange={(e) => patch({ itemCode: e.target.value })} />
            </Field>
            <Field label="Item name" hint="Optional, for display.">
              <Input value={d.item} onChange={(e) => patch({ item: e.target.value })} />
            </Field>
          </div>
          <Field label="Caption" hint="Optional — what the inspector should be looking at.">
            <Input dir="auto" value={d.caption} onChange={(e) => patch({ caption: e.target.value })} />
          </Field>
          <div>
            <span className="label">Reference image</span>
            <ImagePicker
              imageIds={d.imageId ? [d.imageId] : []}
              onChange={(ids) => patch({ imageId: ids[0] ?? '' } as Partial<RefImageDraft>)}
            />
            <p className="mt-1 text-xs text-slate-400">
              One image per entry — adding another replaces the current reference.
            </p>
          </div>
        </>
      )}
    />
  )
}
