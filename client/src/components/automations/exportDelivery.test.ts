import { describe, expect, it } from 'vitest'
import type { AutomationDelivery } from '@qc/shared/automation'
import { aiStamp } from '@/components/ai/exportAiResult'
import { deliveryExportMessage, deliveryFilename, deliverySheets } from './exportDelivery'

const delivery: AutomationDelivery = {
  id: 'd1',
  automationId: 'a1',
  automationName: 'Daily rejects',
  ranAt: '2026-10-10T05:00:00Z',
  period: { from: '2026-10-09', to: '2026-10-09', label: 'Yesterday' },
  summary: 'Line 3 had **twice** the rejects of line 1.',
  language: 'en',
  sections: [
    { title: 'Rejects by machine', ok: true, columns: ['machine', 'rejects'], rows: [['RF-01', 12], ['RF-02', true]], rowCount: 2, truncated: false, ms: 40 },
    { title: 'Holds', ok: false, error: 'column "x" does not exist', columns: [], rows: [], rowCount: 0, truncated: false, ms: 3 },
  ],
}

describe('a delivered report to Excel', () => {
  it('opens on a sheet saying what it is, when it ran, over which days, its summary and where each section is', () => {
    const [about, first, second] = deliverySheets(delivery)
    expect(about.name).toBe('Report')
    expect(about.rows.slice(0, 5)).toEqual([
      ['Report', 'Daily rejects'],
      ['Delivered', aiStamp(delivery.ranAt)],
      ['Period', 'Yesterday (9 Oct 2026)'],
      ['Summary', 'Line 3 had **twice** the rejects of line 1.'],
      ['Sections', 2],
    ])
    expect(about.rows).toContainEqual(['Sheet', '1 Rejects by machine'])
    expect(about.rows).toContainEqual(['Complete', 'Yes'])
    expect(about.rows).toContainEqual(['Error', 'column "x" does not exist'])
    // A section's rows as they were delivered: numbers stay numbers, a yes/no reads as one.
    expect(first).toEqual({ name: '1 Rejects by machine', header: ['machine', 'rejects'], rows: [['RF-01', 12], ['RF-02', 'Yes']] })
    expect(second).toEqual({ name: '2 Holds', header: ['Error'], rows: [['column "x" does not exist']] })
  })

  it('says why there is no summary, a period it did not have, and a section cut short', () => {
    const plain: AutomationDelivery = {
      ...delivery,
      period: null,
      summary: undefined,
      summaryNote: "No summary this time: the assistant's monthly limit is reached.",
      sections: [{ ...delivery.sections[0], truncated: true }],
    }
    const [about] = deliverySheets(plain)
    expect(about.rows).toContainEqual(['Period', 'Its queries take no period'])
    expect(about.rows).toContainEqual(['Summary', "No summary this time: the assistant's monthly limit is reached."])
    expect(about.rows).toContainEqual(['Complete', 'No — only the first 2 rows were delivered'])
    expect(deliveryExportMessage(plain)).toBe('Exported 1 section, 2 rows. A section holds only the rows that were delivered.')
  })

  it('names the file after the automation and the moment it ran, and says what it holds', () => {
    expect(deliveryFilename(delivery)).toBe(`QC-Report-Daily-rejects-${aiStamp(delivery.ranAt).replace(' ', '-').replace(':', '')}.xlsx`)
    expect(deliveryExportMessage(delivery)).toBe('Exported 2 sections, 2 rows. 1 failed — the workbook says why.')
  })
})

describe('a delivered saved report to Excel', () => {
  it('names the saved report it sent and the values it ran for', () => {
    const sent: AutomationDelivery = {
      ...delivery,
      period: null,
      report: { id: 'r1', title: 'Order tracking', open: true },
      inputs: [
        { label: 'Orders', value: '20332, 20378' },
        { label: 'Planning week', value: '42' },
      ],
    }
    const [about] = deliverySheets(sent)
    expect(about.rows.slice(0, 6)).toEqual([
      ['Report', 'Daily rejects'],
      ['Delivered', aiStamp(delivery.ranAt)],
      ['Saved report', 'Order tracking'],
      ['Orders', '20332, 20378'],
      ['Planning week', '42'],
      ['Period', 'As the report covers'],
    ])
  })
})
