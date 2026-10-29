import { describe, expect, it } from 'vitest'
import { CertificateRejected, certificateForm } from './mtc'

const file = (name: string, body: string, type = '') => new File([body], name, { type })

describe('a certificate as the person picks it', () => {
  it('sends one PDF as it is', async () => {
    const pdf = file('cert.pdf', '%PDF-1.4 ...', 'application/pdf')
    const { form, name } = await certificateForm([pdf])
    expect(name).toBe('cert.pdf')
    expect((form.get('file') as File).name).toBe('cert.pdf')
    expect(form.get('sheet')).toBeNull()
  })

  it('reads a spreadsheet here, and sends its text with its name', async () => {
    const { form } = await certificateForm([file('Ezz coils.csv', 'Coil,Thickness\nX9,2.5\n', 'text/csv')])
    expect(form.get('fileName')).toBe('Ezz coils.csv')
    expect(form.get('sheet')).toBe('## Sheet "Ezz coils" (2 rows × 2 columns)\nCoil,Thickness\nX9,2.5')
    expect(form.get('file')).toBeNull()
    // A CSV is its text alone: only a workbook is sent to be kept.
    expect(form.get('original')).toBeNull()
  })

  it('takes one certificate at a time, and only what Claude can read', async () => {
    const reject = (files: File[]) => certificateForm(files).then(() => null, (e: unknown) => (e instanceof CertificateRejected ? e.message : String(e)))
    expect(await reject([])).toMatch(/Pick the certificate/)
    expect(await reject([file('notes.docx', 'x')])).toBe('“notes.docx” is not a PDF, a photo or a spreadsheet.')
    expect(await reject([file('a.pdf', '%PDF', 'application/pdf'), file('b.csv', 'a,b', 'text/csv')])).toMatch(/one certificate at a time/)
    expect(await reject(Array.from({ length: 11 }, (_, i) => file(`p${i}.jpg`, 'x', 'image/jpeg')))).toMatch(/at most 10 photos/)
    expect(await reject([file('empty.csv', '', 'text/csv')])).toBe('That spreadsheet is empty.')
  })
})
