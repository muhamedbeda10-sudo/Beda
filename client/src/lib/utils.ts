
/** Tailwind classnames merge helper (lightweight — no dependency). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

let counter = 0
/** A locally unique key for UI rows (draft defects, toasts). Not a record id —
 *  the API assigns those. */
export function uid(prefix = 'id'): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`
}

export function nowISO(): string {
  return new Date().toISOString()
}

// ---- Dates and times ---------------------------------------------------------
// One format everywhere, whatever the device's language: this year's dates
// carry the time ("Oct 5, 15:05"), other years' the year ("Oct 5, 2025"), on a
// 24-hour clock. The full timestamp is the date's tooltip (see <When>).

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const FULL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

function parse(iso?: string | null): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}
const thisYear = (d: Date) => d.getFullYear() === new Date().getFullYear()

/** A day: "Oct 5" this year, "Oct 5, 2025" another. */
export function formatDate(iso?: string | null): string {
  const d = parse(iso)
  if (!d) return '—'
  return (thisYear(d) ? DAY : DAY_YEAR).format(d)
}

/** A moment: "Oct 5, 15:05" this year, "Oct 5, 2025" another. */
export function formatDateTime(iso?: string | null): string {
  const d = parse(iso)
  if (!d) return '—'
  return thisYear(d) ? `${DAY.format(d)}, ${TIME.format(d)}` : DAY_YEAR.format(d)
}

/** The time of day alone, on a 24-hour clock: "15:05". */
export function formatTime(iso?: string | null): string {
  const d = parse(iso)
  return d ? TIME.format(d) : '—'
}

/** The whole timestamp, for a tooltip: "Mon, Oct 5, 2026, 15:05:22". */
export function formatFullTimestamp(iso?: string | null): string {
  const d = parse(iso)
  return d ? FULL.format(d) : ''
}

export function timeAgo(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

/** Simple CSV parser supporting quoted fields. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') {
        row.push(field)
        field = ''
      } else if (c === '\n') {
        row.push(field)
        rows.push(row)
        row = []
        field = ''
      } else if (c === '\r') {
        // ignore
      } else field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export function downloadText(filename: string, text: string, mime = 'text/csv') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** A UUID for idempotency keys the API validates (§9.3). */
export function newSubmissionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Very old WebViews: assemble a v4 UUID from getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Splits a list into consecutive slices of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
