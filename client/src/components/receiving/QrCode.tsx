// ============================================================================
// §27 — A QR code drawn as an SVG: crisp at any size on paper, black on white
// whatever the theme (a scanner reads dark on light). Its text goes in as
// UTF-8, so Arabic names read back as written.
// ============================================================================

import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** The text's UTF-8 bytes, one character each: what the generator's byte mode writes as they are. */
const utf8Binary = (text: string) => Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join('')

export function QrCode({ text, size = 120, label }: { text: string; size?: number; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(utf8Binary(text), 'Byte')
    qr.make()
    const count = qr.getModuleCount()
    const path: string[] = []
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path.push(`M${c + 4} ${r + 4}h1v1h-1z`)
    return { count: count + 8, d: path.join('') }
  }, [text])
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${cells.count} ${cells.count}`} shapeRendering="crispEdges" className="shrink-0">
      <rect width={cells.count} height={cells.count} fill="#ffffff" />
      <path d={cells.d} fill="#000000" />
    </svg>
  )
}
