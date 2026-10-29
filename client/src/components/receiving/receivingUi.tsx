// ============================================================================
// §27 — What every receiving screen shows the same way: a line's decision
// and a note's state as badges, quantities with their unit.
// ============================================================================

import { Fragment } from 'react'
import { DELIVERY_NOTE_STATUS_NAMES, RECEIVING_STATUS_NAMES, type DeliveryNoteStatus, type ReceivingLineStatus } from '@qc/shared/receiving'
import { Badge, type BadgeTone } from '@/components/ui'

export const LINE_TONE: Record<ReceivingLineStatus, BadgeTone> = { pending: 'blue', accepted: 'green', partial: 'amber', rejected: 'red', hold: 'violet' }
export const NOTE_TONE: Record<DeliveryNoteStatus, BadgeTone> = { 'awaiting-qc': 'blue', hold: 'violet', decided: 'amber', closed: 'neutral' }

export const LineBadge = ({ status }: { status: ReceivingLineStatus }) => <Badge tone={LINE_TONE[status]}>{RECEIVING_STATUS_NAMES[status]}</Badge>
export const NoteBadge = ({ status }: { status: DeliveryNoteStatus }) => <Badge tone={NOTE_TONE[status]}>{DELIVERY_NOTE_STATUS_NAMES[status]}</Badge>

/** A quantity as the paper writes it: up to three decimals, then its unit. */
export const qtyText = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${Number(v.toFixed(3)).toLocaleString()}${unit ? ` ${unit}` : ''}`)

/** A day as the floor reads it: 29 Oct 2026. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
export const dayText = (iso: string) => (iso ? DAY.format(new Date(`${iso}T00:00:00Z`)) : '—')

/** Parts of a line joined by " · ", each isolated in its own direction: an Arabic description beside a drawing number reads as written. */
export function Parts({ parts, empty = '—' }: { parts: readonly (string | null | undefined | false)[]; empty?: string }) {
  const kept = parts.filter((x): x is string => !!x)
  if (!kept.length) return <>{empty}</>
  return <>{kept.map((x, i) => <Fragment key={i}>{i > 0 && ' · '}<bdi>{x}</bdi></Fragment>)}</>
}
