// ============================================================================
// Report styles: how reports look when they leave the app — printed (PDF) and
// in Excel. Each person given the assistant keeps their own styles and uses
// the shared ones; someone with the Configuration permission shares a style
// with everyone and chooses the company's default, which answers and reports
// without a style of their own print in.
//
// A style is made by hand or by the assistant: from a sample (a PDF of a
// report the person likes, or photos of its pages, drawn into pictures on
// the device and read by the assistant, which also finds its logo), and from
// a change put in words ("make the header green", "add a signature box for
// the plant manager"). What the assistant proposes lands in the editor, to
// look at in the preview and change before it is saved. Every save is a
// version, listed under the editor; with document control on, the revision
// moves on by itself when the look changes.
// ============================================================================

import '@/components/ai/fonts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Copy, FileUp, History, ImagePlus, Loader2, Palette, Pencil, Plus, Share2, Sparkles, Star, Trash2, Wand2, X } from 'lucide-react'
import {
  BUILTIN_REPORT_STYLE,
  BUILTIN_REPORT_STYLE_NAME,
  REPORT_STYLE_BORDERS,
  REPORT_STYLE_COLOR_KEYS,
  REPORT_STYLE_FIGURES,
  REPORT_STYLE_FONTS,
  REPORT_STYLE_INSTRUCTION_MAX,
  REPORT_STYLE_LOGO_POSITIONS,
  REPORT_STYLE_LOGO_SIZES,
  REPORT_STYLE_MAX_APPROVALS,
  REPORT_STYLE_NAME_MAX,
  REPORT_STYLE_ORIENTATIONS,
  REPORT_STYLE_RULES,
  REPORT_STYLE_TEXT_MAX,
  isHexColor,
  type ReportStyle,
  type ReportStyleColors,
  type ReportStyleSpec,
  type ResolvedReportStyle,
} from '@qc/shared/reportStyles'
import { Badge, Button, Card, Field, Input, Modal, Select } from '@/components/ui'
import { StylePreview } from '@/components/reportStyles/StylePreview'
import { SampleError, logoFromFile, logoFromPage, samplePages } from '@/components/reportStyles/samplePages'
import { ApiError } from '@/lib/api'
import { cn, formatDateTime } from '@/lib/utils'
import {
  chooseDefaultReportStyle,
  deleteReportStyle,
  draftReportStyle,
  saveReportStyle,
  shareReportStyle,
  useReportStyles,
  useReportStyleVersions,
} from '@/services/reportStyles'
import { useApp } from '@/store/AppContext'

const COLOR_NAMES: Record<keyof ReportStyleColors, string> = {
  primary: 'Main colour',
  accent: 'Second colour',
  heading: 'Titles',
  text: 'Text',
  tableHeaderBg: 'Table header',
  tableHeaderText: 'Table header text',
  tableStripe: 'Striped rows',
  tableBorder: 'Lines',
}
const WORDS: Record<string, string> = {
  left: 'Left',
  right: 'Right',
  center: 'Centre',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  portrait: 'Portrait (standing)',
  landscape: 'Landscape (lying)',
  double: 'Two colours',
  single: 'One line',
  none: 'None',
  all: 'A full grid',
  rows: 'Lines between rows',
  cards: 'Cards',
  boxed: 'Boxes',
  plain: 'Plain',
}

/** What the editor holds: a style being made or changed. */
interface Draft {
  /** The style changed; null for a new one. */
  base: ReportStyle | null
  name: string
  spec: ReportStyleSpec
  logoDataUrl: string | null
}

const newDraft = (from?: Pick<ReportStyle, 'name' | 'spec' | 'logoDataUrl'>, copy = false): Draft => ({
  base: null,
  name: from ? (copy ? `Copy of ${from.name}`.slice(0, REPORT_STYLE_NAME_MAX) : from.name) : 'New style',
  spec: structuredClone(from?.spec ?? BUILTIN_REPORT_STYLE),
  logoDataUrl: from?.logoDataUrl ?? null,
})

export function ReportStylesPage() {
  const { data, isLoading, isError, refetch } = useReportStyles()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [sampleFirst, setSampleFirst] = useState(false)

  if (draft) return <StyleEditor initial={draft} startWithSample={sampleFirst} onClose={() => setDraft(null)} />

  const styles = data?.styles ?? []
  const shared = styles.filter((s) => s.shared)
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <header className="flex flex-wrap items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
          <Palette className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-extrabold tracking-tight">Report styles</h1>
          <p className="text-13 text-muted">How reports look when they leave the app: printed as PDF, and in Excel</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            className="min-h-[40px] touch:min-h-[44px]"
            onClick={() => {
              setSampleFirst(true)
              setDraft(newDraft())
            }}
          >
            <Sparkles className="h-4 w-4" /> From a sample
          </Button>
          <Button
            className="min-h-[40px] touch:min-h-[44px]"
            onClick={() => {
              setSampleFirst(false)
              setDraft(newDraft())
            }}
          >
            <Plus className="h-4 w-4" /> New style
          </Button>
        </div>
      </header>

      <Card className="p-3 text-13 text-slate-600 dark:text-slate-300">
        Upload a report you like — a PDF, or photos of its pages — and the assistant copies its look: colours, logo, letterhead, document number and signature boxes. Then choose the style
        for a report from the report itself. Answers print in the company’s default.
      </Card>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the styles…
        </p>
      )}
      {isError && !data && (
        <Card className="p-4 text-sm text-rose-700 dark:text-rose-300">
          The styles could not be loaded.{' '}
          <button type="button" onClick={() => void refetch()} className="font-semibold underline">
            Try again
          </button>
        </Card>
      )}

      {data && (
        <>
          <CompanyDefault styles={shared} defaultId={data.defaultId} canManage={data.canManage} />
          <div className="grid gap-3 sm:grid-cols-2">
            <BuiltInCard onCopy={() => setDraft(newDraft({ name: BUILTIN_REPORT_STYLE_NAME, spec: BUILTIN_REPORT_STYLE, logoDataUrl: null }, true))} isDefault={data.defaultId === null} />
            {styles.map((s) => (
              <StyleCard
                key={s.id}
                style={s}
                canManage={data.canManage}
                onEdit={() => setDraft({ ...newDraft(s), base: s })}
                onCopy={() => setDraft(newDraft(s, true))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** The company's default: what it is, and for someone with the Configuration permission, the choice of it. */
function CompanyDefault({ styles, defaultId, canManage }: { styles: ReportStyle[]; defaultId: string | null; canManage: boolean }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const current = styles.find((s) => s.id === defaultId)
  const choose = async (id: string) => {
    setBusy(true)
    try {
      await chooseDefaultReportStyle(qc, id || null)
      toast('The company’s report style is chosen.', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'It could not be chosen.', 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3">
      <Star className="h-4 w-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 text-13">
        <span className="font-semibold">Company default:</span> <span dir="auto">{current?.name ?? BUILTIN_REPORT_STYLE_NAME}</span>
        <p className="text-xs text-muted">Answers, and reports without a style of their own, print in it.</p>
      </div>
      {canManage && (
        <Select className="w-auto min-w-[14rem]" value={defaultId ?? ''} onChange={(e) => void choose(e.target.value)} disabled={busy} aria-label="Company default style">
          <option value="">{BUILTIN_REPORT_STYLE_NAME}</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
    </Card>
  )
}

/** A style's look at a glance: its colours, as a strip. */
function Swatches({ spec }: { spec: ReportStyleSpec }) {
  return (
    <div className="flex h-2.5 overflow-hidden rounded-full ring-1 ring-slate-200 dark:ring-slate-700" aria-hidden>
      {(['primary', 'accent', 'tableHeaderBg', 'heading', 'tableStripe'] as const).map((k) => (
        <span key={k} className="flex-1" style={{ background: spec.colors[k] }} />
      ))}
    </div>
  )
}

function BuiltInCard({ onCopy, isDefault }: { onCopy: () => void; isDefault: boolean }) {
  return (
    <Card className="space-y-2.5 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <h2 className="min-w-0 flex-1 text-sm font-bold">{BUILTIN_REPORT_STYLE_NAME}</h2>
        {isDefault && <Badge tone="amber">Default</Badge>}
      </div>
      <Swatches spec={BUILTIN_REPORT_STYLE} />
      <p className="text-xs text-muted">The app’s own look. Copy it to start a style of your own.</p>
      <div className="flex flex-wrap gap-2">
        <Button className="h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11" onClick={onCopy}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
      </div>
    </Card>
  )
}

function StyleCard({ style: s, canManage, onEdit, onCopy }: { style: ReportStyle; canManage: boolean; onEdit: () => void; onCopy: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const act = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await what()
      toast(done, 'success')
      setConfirming(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }
  const small = 'h-8 min-h-0 gap-1.5 px-2.5 py-0 text-xs touch:h-11'
  return (
    <Card className="space-y-2.5 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <h2 dir="auto" className="min-w-0 flex-1 truncate text-sm font-bold">
          {s.name}
        </h2>
        {s.isDefault && <Badge tone="amber">Default</Badge>}
        {s.shared && <Badge tone="blue">Shared</Badge>}
      </div>
      <Swatches spec={s.spec} />
      <p className="text-xs text-muted">
        {s.mine ? 'Yours' : `By ${s.ownerName}`} · version {s.version} · {formatDateTime(s.updatedAt)}
        {s.spec.docControl.enabled && s.spec.docControl.docNo ? ` · ${s.spec.docControl.docNo} rev. ${s.spec.docControl.revision || '—'}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {s.mine && (
          <Button className={small} onClick={onEdit} disabled={busy}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        )}
        <Button className={small} onClick={onCopy} disabled={busy}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
        {canManage && (
          <Button className={small} onClick={() => void act(() => shareReportStyle(qc, s.id, !s.shared), s.shared ? 'No longer shared.' : 'Shared with everyone.')} disabled={busy || (s.shared && s.isDefault)}>
            <Share2 className="h-3.5 w-3.5" /> {s.shared ? 'Stop sharing' : 'Share with everyone'}
          </Button>
        )}
        {canManage && s.shared && !s.isDefault && (
          <Button className={small} onClick={() => void act(() => chooseDefaultReportStyle(qc, s.id), 'It is the company’s default now.')} disabled={busy}>
            <Star className="h-3.5 w-3.5" /> Make default
          </Button>
        )}
        {s.mine && (
          <Button variant="ghost" className={cn(small, 'text-rose-700 dark:text-rose-300')} onClick={() => setConfirming(true)} disabled={busy}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        )}
      </div>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this style?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Keep it</Button>
            <Button variant="danger" onClick={() => void act(() => deleteReportStyle(qc, s.id), 'Style deleted.')} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Delete
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Reports that print in “<span dir="auto">{s.name}</span>” will print in the company’s default instead.
          {s.isDefault ? ' It is the company’s default: until another is chosen, reports print in the app’s own look.' : ''}
        </p>
      </Modal>
    </Card>
  )
}

// ---- The editor -----------------------------------------------------------------------------------

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-bold">{title}</h2>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  )
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {WORDS[o] ?? o}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-[40px] cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" value={isHexColor(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900" aria-label={label} />
        <Input
          value={text}
          maxLength={7}
          onChange={(e) => {
            setText(e.target.value)
            const v = e.target.value.trim()
            const hex = v.startsWith('#') ? v : `#${v}`
            if (isHexColor(hex)) onChange(hex.toUpperCase())
          }}
          className="font-mono uppercase"
          aria-label={`${label} (hex)`}
        />
      </div>
    </Field>
  )
}

/** Whether a save failed because the style changed elsewhere since it was opened. */
const stale = (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === 'conflict'

function StyleEditor({ initial, startWithSample, onClose }: { initial: Draft; startWithSample: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { toast } = useApp()
  const [base, setBase] = useState(initial.base)
  const [name, setName] = useState(initial.name)
  const [spec, setSpec] = useState<ReportStyleSpec>(initial.spec)
  const [logo, setLogo] = useState<string | null>(initial.logoDataUrl)
  const [saving, setSaving] = useState(false)
  const preview: ResolvedReportStyle = useMemo(() => ({ id: base?.id ?? null, name, version: base?.version ?? 1, spec, logoDataUrl: logo }), [base, name, spec, logo])
  const logoInput = useRef<HTMLInputElement>(null)
  const top = useRef<HTMLDivElement>(null)
  // Opened from further down the list: the editor starts at its top.
  useEffect(() => top.current?.scrollIntoView({ block: 'start' }), [])

  const set = <K extends keyof ReportStyleSpec>(key: K, value: ReportStyleSpec[K]) => setSpec((s) => ({ ...s, [key]: value }))
  const setIn = <K extends 'colors' | 'logo' | 'header' | 'docControl' | 'table' | 'footer' | 'approvals'>(key: K, part: Partial<ReportStyleSpec[K]>) =>
    setSpec((s) => ({ ...s, [key]: { ...s[key], ...part } }))

  const pickLogo = async (file: File | undefined) => {
    if (!file) return
    try {
      setLogo(await logoFromFile(file))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The logo could not be read.', 'error')
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const saved = await saveReportStyle(qc, base?.id ?? null, { name, spec, logoDataUrl: logo, ...(base ? { version: base.version } : {}) })
      toast(base ? `Saved as version ${saved.version}.` : 'Style saved.', 'success')
      setBase(saved)
      setSpec(saved.spec)
      setName(saved.name)
    } catch (e) {
      if (stale(e)) toast('This style was changed elsewhere since you opened it. Open it again to see that version, then make your change.', 'error')
      else toast(e instanceof Error ? e.message : 'The style could not be saved.', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={top} className="mx-auto w-full max-w-6xl scroll-mt-20 space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onClose} className="icon-btn h-10 w-10 touch:h-11 touch:w-11" aria-label="Back to the styles">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-extrabold tracking-tight">{base ? 'Edit style' : 'New style'}</h1>
          {base && <p className="text-xs text-muted">Version {base.version} · saved {formatDateTime(base.updatedAt)} by {base.updatedByName}</p>}
        </div>
        <Button variant="primary" className="min-h-[40px] touch:min-h-[44px]" onClick={() => void save()} disabled={saving || !name.trim()}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
        </Button>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <AssistantBox spec={spec} startWithSample={startWithSample} onDraft={(d, newLogo) => {
            setSpec(d.spec)
            if (!base && (name === 'New style' || !name.trim())) setName(d.name)
            if (newLogo) setLogo(newLogo)
          }} />

          <Section title="Name">
            <Input value={name} maxLength={REPORT_STYLE_NAME_MAX} onChange={(e) => setName(e.target.value)} aria-label="Style name" dir="auto" />
          </Section>

          <Section title="Logo and letterhead">
            <div className="flex flex-wrap items-center gap-3">
              <div className="grid h-16 w-40 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-slate-300 bg-white p-1 dark:border-slate-700">
                {logo ? <img src={logo} alt="The style's logo" className="max-h-14 max-w-full object-contain" /> : <span className="text-xs text-muted">LinkMisr logo</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className="h-9 min-h-0 gap-1.5 px-3 py-0 text-13 touch:h-11" onClick={() => logoInput.current?.click()}>
                  <ImagePlus className="h-4 w-4" /> {logo ? 'Change logo' : 'Upload logo'}
                </Button>
                {logo && (
                  <Button variant="ghost" className="h-9 min-h-0 gap-1.5 px-3 py-0 text-13 touch:h-11" onClick={() => setLogo(null)}>
                    <X className="h-4 w-4" /> Use the LinkMisr logo
                  </Button>
                )}
              </div>
              <input
                ref={logoInput}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  void pickLogo(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Choice label="Logo position" value={spec.logo.position} options={REPORT_STYLE_LOGO_POSITIONS} onChange={(v) => setIn('logo', { position: v })} />
              <Choice label="Logo size" value={spec.logo.size} options={REPORT_STYLE_LOGO_SIZES} onChange={(v) => setIn('logo', { size: v })} />
              <Field label="Company name">
                <Input value={spec.header.companyName} maxLength={REPORT_STYLE_TEXT_MAX} onChange={(e) => setIn('header', { companyName: e.target.value })} dir="auto" />
              </Field>
              <Field label="Department">
                <Input value={spec.header.department} maxLength={REPORT_STYLE_TEXT_MAX} onChange={(e) => setIn('header', { department: e.target.value })} dir="auto" />
              </Field>
              <Choice label="Line under the letterhead" value={spec.header.rule} options={REPORT_STYLE_RULES} onChange={(v) => setIn('header', { rule: v })} />
              <Check label="Say what kind of report it is (Saved report, Scheduled report…)" checked={spec.header.showKind} onChange={(v) => setIn('header', { showKind: v })} />
            </div>
          </Section>

          <Section title="Document control" hint="As a quality system numbers its forms. The revision moves on by itself when the look changes, unless you change it in the same save.">
            <Check label="Show the document number, revision and issue date" checked={spec.docControl.enabled} onChange={(v) => setIn('docControl', { enabled: v })} />
            {spec.docControl.enabled && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Doc. No.">
                  <Input value={spec.docControl.docNo} maxLength={60} onChange={(e) => setIn('docControl', { docNo: e.target.value })} placeholder="QF-QC-07" dir="auto" />
                </Field>
                <Field label="Revision">
                  <Input value={spec.docControl.revision} maxLength={20} onChange={(e) => setIn('docControl', { revision: e.target.value })} placeholder="01" />
                </Field>
                <Field label="Issue date">
                  <Input value={spec.docControl.issueDate} maxLength={30} onChange={(e) => setIn('docControl', { issueDate: e.target.value })} placeholder="2026-10-18" />
                </Field>
              </div>
            )}
          </Section>

          <Section title="Colours and typeface">
            <div className="grid gap-3 sm:grid-cols-2">
              {REPORT_STYLE_COLOR_KEYS.map((k) => (
                <ColourField key={k} label={COLOR_NAMES[k]} value={spec.colors[k]} onChange={(v) => setIn('colors', { [k]: v } as Partial<ReportStyleColors>)} />
              ))}
              <Choice label="Typeface" value={spec.font} options={REPORT_STYLE_FONTS} onChange={(v) => set('font', v)} />
              <Choice label="Paper" value={spec.orientation} options={REPORT_STYLE_ORIENTATIONS} onChange={(v) => set('orientation', v)} />
            </div>
          </Section>

          <Section title="Tables, figures and sections">
            <div className="grid gap-3 sm:grid-cols-2">
              <Choice label="Table lines" value={spec.table.borders} options={REPORT_STYLE_BORDERS} onChange={(v) => setIn('table', { borders: v })} />
              <Choice label="Headline figures" value={spec.figures} options={REPORT_STYLE_FIGURES} onChange={(v) => set('figures', v)} />
              <Check label="Stripe every other row" checked={spec.table.stripes} onChange={(v) => setIn('table', { stripes: v })} />
              <Check label="Compact rows" checked={spec.table.compact} onChange={(v) => setIn('table', { compact: v })} />
              <Check label="Number the sections" checked={spec.numbering} onChange={(v) => set('numbering', v)} />
            </div>
          </Section>

          <Section title="Foot of the page and signatures">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Text at the foot of every page">
                <Input value={spec.footer.text} maxLength={REPORT_STYLE_TEXT_MAX} onChange={(e) => setIn('footer', { text: e.target.value })} dir="auto" />
              </Field>
              <Check label="Page numbers (Page 2 of 5)" checked={spec.footer.pageNumbers} onChange={(v) => setIn('footer', { pageNumbers: v })} />
            </div>
            <Check label="Signature boxes at the end" checked={spec.approvals.enabled} onChange={(v) => setIn('approvals', { enabled: v })} />
            {spec.approvals.enabled && (
              <div className="grid gap-2 sm:grid-cols-2">
                {Array.from({ length: REPORT_STYLE_MAX_APPROVALS }, (_, i) => (
                  <Input
                    key={i}
                    value={spec.approvals.labels[i] ?? ''}
                    maxLength={40}
                    placeholder={i === 0 ? 'Prepared by' : i === 1 ? 'Reviewed by' : i === 2 ? 'Approved by' : 'Another box (optional)'}
                    onChange={(e) => {
                      const labels = Array.from({ length: REPORT_STYLE_MAX_APPROVALS }, (_, k) => (k === i ? e.target.value : (spec.approvals.labels[k] ?? '')))
                      // Kept as typed while editing; empty boxes are dropped when saved.
                      setIn('approvals', { labels: labels.slice(0, Math.max(...labels.map((l, k) => (l ? k + 1 : 0)), 0)) })
                    }}
                    aria-label={`Signature box ${i + 1}`}
                    dir="auto"
                  />
                ))}
              </div>
            )}
          </Section>

          {base && <Versions styleId={base.id} onLoad={(v) => setSpec(v)} />}
        </div>

        {/* On a phone, above the choices: what they change is seen first. */}
        <div className="order-first space-y-2 lg:sticky lg:top-4 lg:order-none">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Preview</p>
          <StylePreview style={preview} />
        </div>
      </div>
    </div>
  )
}

/** The assistant's part: a sample to copy, or a change in words; what it proposes lands in the editor. */
function AssistantBox({ spec, startWithSample, onDraft }: { spec: ReportStyleSpec; startWithSample: boolean; onDraft: (d: { spec: ReportStyleSpec; name: string }, logo: string | null) => void }) {
  const { toast } = useApp()
  const [instruction, setInstruction] = useState('')
  const [working, setWorking] = useState<'sample' | 'words' | null>(null)
  const [notes, setNotes] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const abort = useRef<AbortController | null>(null)
  const opened = useRef(false)

  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    if (startWithSample && !opened.current) {
      opened.current = true
      fileInput.current?.click()
    }
  }, [startWithSample])

  const ask = async (kind: 'sample' | 'words', files?: File[]) => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setWorking(kind)
    setNotes('')
    try {
      const images = files ? await samplePages(files) : undefined
      const draft = await draftReportStyle({ ...(images ? { images } : {}), spec, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) }, ac.signal)
      let logo: string | null = null
      if (images && draft.logoBox) {
        try {
          logo = await logoFromPage(images[0], draft.logoBox)
        } catch {
          // The rest of the style stands; the logo is uploaded by hand.
        }
      }
      onDraft(draft, logo)
      setNotes(draft.notes || 'Done. Look at the preview, change what you like, then save.')
      if (kind === 'words') setInstruction('')
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      toast(e instanceof SampleError || e instanceof Error ? e.message : 'The assistant could not do that. Try again.', 'error')
    } finally {
      if (abort.current === ac) setWorking(null)
    }
  }

  return (
    <Card className="space-y-3 border-violet-200 bg-violet-50/50 p-4 dark:border-violet-500/30 dark:bg-violet-500/5">
      <div className="flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-violet-700 dark:text-violet-300" />
        <h2 className="text-sm font-bold">Ask the assistant</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-[40px] touch:min-h-[44px]" onClick={() => fileInput.current?.click()} disabled={working !== null}>
          {working === 'sample' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} {working === 'sample' ? 'Reading the sample…' : 'Copy the look of a sample (PDF or photos)'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length > 0) void ask('sample', files)
          }}
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={REPORT_STYLE_INSTRUCTION_MAX}
          rows={2}
          dir="auto"
          placeholder="Or say what to change: “make the header dark green”, “add a box for the plant manager’s signature”…"
          className="input min-h-[44px] flex-1 resize-y"
          aria-label="What to change"
        />
        <Button variant="primary" className="min-h-[44px] self-start" onClick={() => void ask('words')} disabled={working !== null || !instruction.trim()}>
          {working === 'words' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Change
        </Button>
      </div>
      {notes && (
        <p dir="auto" className="text-13 text-violet-900 dark:text-violet-200">
          {notes}
        </p>
      )}
    </Card>
  )
}

function Versions({ styleId, onLoad }: { styleId: string; onLoad: (spec: ReportStyleSpec) => void }) {
  const { data } = useReportStyleVersions(styleId)
  const versions = data?.versions ?? []
  if (versions.length < 2) return null
  return (
    <Section title="Versions" hint="Each save is kept. Load one to see it in the preview; saving it makes it the newest version.">
      <ul className="divide-y divide-slate-100 text-13 dark:divide-slate-800">
        {versions.map((v, i) => (
          <li key={v.version} className="flex flex-wrap items-center gap-2 py-2">
            <History className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              Version {v.version}
              {i === 0 ? ' (current)' : ''} · {formatDateTime(v.changedAt)} · {v.changedByName}
              {v.spec.docControl.enabled && v.spec.docControl.revision ? ` · rev. ${v.spec.docControl.revision}` : ''}
            </span>
            {i > 0 && (
              <Button className="h-8 min-h-0 px-2.5 py-0 text-xs touch:h-11" onClick={() => onLoad(v.spec)}>
                Load
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}
