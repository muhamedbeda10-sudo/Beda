import type { Response } from 'express'

/** A download's Content-Disposition: the name as written (RFC 5987), and a plain one for clients that read only that. */
export function attachmentDisposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim()
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${plain === '.xlsx' || plain === '' ? 'file.xlsx' : plain}"; filename*=UTF-8''${encoded}`
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** A workbook made for this request, sent as a download that is never cached. */
export function sendWorkbook(res: Response, name: string, bytes: Buffer): void {
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE)
  res.setHeader('Content-Disposition', attachmentDisposition(name))
  res.setHeader('Cache-Control', 'no-store')
  res.end(bytes)
}
