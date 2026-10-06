import { useState } from 'react'
import { BookOpen, FileText } from 'lucide-react'
import { WorkInstructionViewer } from './WorkInstructionViewer'
import type { WorkInstruction, WorkInstructionStep } from '@qc/shared/types'

/**
 * The controlled documents an inspector may open on a wizard step: one
 * button per document, the PDF shown inside the app. Nothing is rendered
 * when the step has no documents, so the plain flow stays uncluttered.
 */
export function WorkInstructionLinks({ instructions, step }: { instructions: WorkInstruction[]; step: WorkInstructionStep }) {
  const [open, setOpen] = useState<WorkInstruction | null>(null)
  const here = instructions.filter((w) => w.step === step)
  if (here.length === 0) return null
  return (
    <div className="rounded-2xl border-l-4 border-l-brand-500 bg-brand-50/60 p-3 dark:bg-brand-500/10">
      <p className="mb-2 flex items-center gap-2 text-sm font-bold text-brand-800 dark:text-brand-100">
        <BookOpen className="h-4 w-4" /> Work instructions
      </p>
      <div className="flex flex-wrap gap-2">
        {here.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => setOpen(w)}
            className="inline-flex min-h-[44px] max-w-full items-center gap-2 rounded-xl bg-white px-3 text-left text-sm font-semibold text-slate-700 shadow-card ring-1 ring-slate-200/80 transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-hover dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700"
          >
            <FileText className="h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300" />
            <span className="truncate">{w.title}</span>
            <span className="shrink-0 text-xs font-medium text-muted">{w.code}</span>
          </button>
        ))}
      </div>
      {open && <WorkInstructionViewer instruction={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
