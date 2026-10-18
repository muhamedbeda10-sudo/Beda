// ============================================================================
// A workbook checked before it is opened. An .xlsx is a zip: a small file can
// unpack to gigabytes and take the server's memory with it, and one may carry
// macros. Its central directory says what is inside without unpacking
// anything: it is read here, and the file refused when it is not a workbook,
// unpacks to more than the limit, holds too many parts, or holds macros.
// ============================================================================

import { REPORT_FORM_MAX_UNPACKED_BYTES } from '@qc/shared/reportStyles'

/** Parts a form's workbook may hold: more is not a form. */
const MAX_ENTRIES = 5_000
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

export class FormFileError extends Error {}

export function checkWorkbookZip(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new FormFileError('This is not an Excel workbook (.xlsx). Save it as .xlsx and upload it again.')
  // The end of the central directory: in the last 64 KB + 22 bytes (its comment may be up to 64 KB).
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new FormFileError('This workbook is damaged. Open it in Excel, save it again, and upload it.')
  const entries = bytes.readUInt16LE(eocd + 10)
  const start = bytes.readUInt32LE(eocd + 16)
  if (entries === 0xffff || start === 0xffffffff) throw new FormFileError('This workbook is too large to be a form.')
  if (entries > MAX_ENTRIES) throw new FormFileError('This workbook holds too many parts to be a form.')
  let at = start
  let unpacked = 0
  const names = new Set<string>()
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new FormFileError('This workbook is damaged. Open it in Excel, save it again, and upload it.')
    const size = bytes.readUInt32LE(at + 24)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    names.add(name.toLowerCase())
    unpacked += size
    if (unpacked > REPORT_FORM_MAX_UNPACKED_BYTES) throw new FormFileError('This workbook unpacks to too much to be a form. Remove what the form does not need (pictures, other sheets) and upload it again.')
    at += 46 + nameLength + extraLength + commentLength
  }
  if (!names.has('[content_types].xml') || !names.has('xl/workbook.xml')) throw new FormFileError('This is not an Excel workbook (.xlsx). Save it as .xlsx and upload it again.')
  if ([...names].some((n) => n.endsWith('vbaproject.bin'))) throw new FormFileError('This workbook holds macros. Save the form as a plain workbook (.xlsx) and upload it again.')
}
