import { useState } from 'react'
import { Search, Package, PenLine, Loader2, Check } from 'lucide-react'
import { Badge, Button, Input, Modal } from '@/components/ui'
import { useCoilSearch } from '@/services/queries'
import { gradesEquivalent } from '@qc/shared/rules'
import type { Coil } from '@qc/shared/types'

/**
 * Pick the coil in use from the coil register (§5.2). The register is
 * searched on the server by number prefix; the picked coil's grade, supplier
 * and gauge are copied onto the sample so the record stays true even if the
 * register changes later.
 *
 * A coil the register has not received yet can still be typed by hand — the
 * inspection must not stall on a late import — and is saved without a link
 * to the register, which the history screens show as "typed".
 *
 * A coil already on the sample (the previous sample's coils are carried onto
 * the next one) stays tappable: the tap says so and points at it, rather than
 * greying the coil out as if it could not be chosen again.
 */
export function CoilPicker({
  open,
  onClose,
  onPick,
  onTyped,
  onAlready,
  expectedGrade,
  gradeIndex,
  alreadyChosen,
}: {
  open: boolean
  onClose: () => void
  onPick: (coil: Coil) => void
  onTyped: (coilNumber: string) => void
  /** Tapped a coil that is already on the sample: point at it rather than add it twice. */
  onAlready?: (coilNumber: string) => void
  /** The grade the order line expects; a differing coil is flagged in the list. */
  expectedGrade: string
  gradeIndex: Map<string, string>
  /** Coil numbers already on the sample, shown as such rather than re-added. */
  alreadyChosen: string[]
}) {
  const [term, setTerm] = useState('')
  const { data: results = [], isFetching } = useCoilSearch(term, 25)
  const typed = term.trim()
  const chosen = new Set(alreadyChosen.map((n) => n.trim().toLowerCase()))
  const exactMatch = results.some((c) => c.coilNumber.trim().toLowerCase() === typed.toLowerCase())

  function close() {
    setTerm('')
    onClose()
  }

  function already(coilNumber: string) {
    onAlready?.(coilNumber)
    close()
  }

  return (
    <Modal open={open} onClose={close} title="Add coil" icon={<Package className="h-5 w-5" />} size="lg">
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Coil number…"
            className="min-h-[48px] pl-9"
            autoCapitalize="characters"
          />
          {isFetching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />}
        </div>
        {alreadyChosen.length > 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {alreadyChosen.length === 1 ? 'One coil is' : `${alreadyChosen.length} coils are`} already on this sample, carried from the previous one. Pick another to add it alongside, or Remove one from the list to replace it.
          </p>
        )}

        <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
          {results.length === 0 && (
            <p className="py-6 text-center text-sm text-slate-400">
              {typed ? 'No coil in the register starts with that number.' : 'Type the number stamped on the coil.'}
            </p>
          )}
          {results.map((c) => {
            const taken = chosen.has(c.coilNumber.trim().toLowerCase())
            const mismatch = !!expectedGrade && !!c.grade && !gradesEquivalent(expectedGrade, c.grade, gradeIndex)
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  if (taken) return already(c.coilNumber)
                  onPick(c)
                  close()
                }}
                aria-label={taken ? `${c.coilNumber}, already on this sample` : undefined}
                className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/50 dark:hover:border-brand-500/50 dark:hover:bg-brand-500/5 ${taken ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-500/5' : 'border-slate-200 dark:border-slate-800'}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{c.coilNumber}</p>
                  <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                    {[c.supplier, c.thickness !== undefined ? `${c.thickness} mm` : null, c.width !== undefined ? `${c.width} wide` : null]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </p>
                </div>
                <span className="flex flex-col items-end gap-1">
                  {c.grade ? <Badge tone={mismatch ? 'red' : 'green'}>{c.grade}</Badge> : <Badge tone="neutral">no grade</Badge>}
                  {taken && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                      <Check className="h-3.5 w-3.5" /> On this sample
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>

        {typed && !exactMatch && results.length === 0 && (
          <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50/60 p-3 dark:border-amber-500/40 dark:bg-amber-500/5">
            <p className="text-sm text-amber-800 dark:text-amber-200">
              <strong>{typed}</strong> is not in the coil register. You can still record it by hand; it will be saved without
              grade or supplier details and marked as typed.
            </p>
            <Button
              variant="secondary"
              className="mt-2 min-h-[44px]"
              onClick={() => {
                if (chosen.has(typed.toLowerCase())) return already(typed)
                onTyped(typed)
                close()
              }}
            >
              <PenLine className="h-4 w-4" /> Add "{typed}" by hand
            </Button>
          </div>
        )}
        {typed && !exactMatch && results.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (chosen.has(typed.toLowerCase())) return already(typed)
              onTyped(typed)
              close()
            }}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-700 dark:hover:bg-slate-800"
          >
            <PenLine className="h-4 w-4" /> None of these — add "{typed}" by hand
          </button>
        )}
      </div>
    </Modal>
  )
}
