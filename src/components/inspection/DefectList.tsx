import { useState } from 'react'
import { Plus, Trash2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import type { InspectionSample, VisualDefectResult, Disposition, DefectSeverity } from '@/types'
import { useDB, actions } from '@/store/db'
import { defectsOf, imagesOf } from '@/lib/selectors'
import { Badge, Button, Field, Input, Modal, Select, dispositionTone } from '@/components/ui'
import { ImageStrip } from './ImageStrip'
import { cn } from '@/lib/utils'

const DISPOSITIONS: Disposition[] = ['Accepted', 'Hold', 'Rejected']
const SEVERITIES: DefectSeverity[] = ['Minor', 'Major', 'Critical']

export function DefectList({ sample, sessionId }: { sample: InspectionSample; sessionId: string }) {
  const db = useDB()
  const defects = defectsOf(db, sample.id)
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <AlertTriangle className="h-4 w-4" /> Visual Defects
          {defects.length > 0 && <Badge tone="red">{defects.length}</Badge>}
        </h4>
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {defects.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-sm text-slate-400 dark:border-slate-700">
          No defects recorded.
        </p>
      ) : (
        <div className="space-y-2">
          {defects.map((d) => {
            const imgs = imagesOf(db, 'defect', d.id)
            const open = expanded[d.id]
            return (
              <div
                key={d.id}
                dir="auto"
                className={cn(
                  'rounded-2xl border p-3',
                  d.disposition === 'Rejected'
                    ? 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/5'
                    : d.disposition === 'Hold'
                      ? 'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5'
                      : 'border-slate-200 dark:border-slate-700',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle
                      className={cn(
                        'h-5 w-5 shrink-0',
                        d.disposition === 'Rejected' ? 'text-rose-500' : d.disposition === 'Hold' ? 'text-amber-500' : 'text-slate-400',
                      )}
                    />
                    <div>
                      <p className="font-bold">{d.title}</p>
                      <p className="text-xs text-slate-400">{d.defectCode} · {d.severity}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-xs font-bold uppercase text-slate-500">{d.disposition}</span>
                    {d.qty > 0 && <Badge tone="red">Qty: {d.qty}</Badge>}
                  </div>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">{d.description}</p>

                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [d.id]: !e[d.id] }))}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 dark:text-brand-400"
                  >
                    {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {open ? 'Hide' : 'Edit'} · {imgs.length} photo{imgs.length === 1 ? '' : 's'}
                  </button>
                  <button
                    onClick={() => actions.deleteDefect(d.id)}
                    className="ml-auto rounded p-1 text-slate-300 hover:text-rose-500"
                    aria-label="Delete defect"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {open && (
                  <div className="mt-3 space-y-3 border-t border-slate-200/70 pt-3 dark:border-slate-700">
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Disposition">
                        <Select
                          value={d.disposition}
                          onChange={(e) => {
                            actions.updateDefect(d.id, { disposition: e.target.value as Disposition })
                            actions.recomputeSample(sample.id)
                          }}
                        >
                          {DISPOSITIONS.map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Quantity">
                        <Input
                          type="number"
                          inputMode="numeric"
                          defaultValue={d.qty}
                          onBlur={(e) => actions.updateDefect(d.id, { qty: Number(e.target.value) || 0 })}
                        />
                      </Field>
                    </div>
                    <div>
                      <span className="label">Photos</span>
                      <ImageStrip images={imgs} ownerKind="defect" ownerId={d.id} sessionId={sessionId} compact />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {adding && (
        <AddDefectDialog
          sampleId={sample.id}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            actions.recomputeSample(sample.id)
          }}
        />
      )}
    </div>
  )
}

function AddDefectDialog({ sampleId, onClose, onDone }: { sampleId: string; onClose: () => void; onDone: () => void }) {
  const db = useDB()
  const [typeId, setTypeId] = useState(db.defectTypes[0]?.id ?? '')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<DefectSeverity>('Major')
  const [disposition, setDisposition] = useState<Disposition>('Hold')
  const [qty, setQty] = useState('1')

  function save() {
    const dt = db.defectTypes.find((t) => t.id === typeId)
    if (!dt) return
    actions.addDefect({
      sampleId,
      defectCode: dt.code,
      title: dt.title,
      description: description || dt.description,
      severity,
      qty: Number(qty) || 0,
      disposition,
    })
    onDone()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Record visual defect"
      icon={<AlertTriangle className="h-5 w-5" />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            <Plus className="h-4 w-4" /> Add defect
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Defect type">
          <Select
            value={typeId}
            onChange={(e) => {
              setTypeId(e.target.value)
              const dt = db.defectTypes.find((t) => t.id === e.target.value)
              if (dt) setSeverity(dt.defaultSeverity)
            }}
          >
            {db.defectTypes
              .filter((t) => t.active)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} · {t.title}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Description" hint="Describe the defect (supports Arabic)">
          <textarea
            dir="auto"
            className="input min-h-[76px] resize-y"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. البعد K خارج التجاوز…"
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value as DefectSeverity)}>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label="Disposition">
            <Select value={disposition} onChange={(e) => setDisposition(e.target.value as Disposition)}>
              {DISPOSITIONS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label="Qty">
            <Input type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
        </div>
        {disposition === 'Hold' && (
          <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> Hold defects must be resolved before the session can be closed.
          </div>
        )}
      </div>
    </Modal>
  )
}
