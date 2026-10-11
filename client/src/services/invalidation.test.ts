// ============================================================================
// The dashboard reads the same inspection record the rest of the app writes.
// A session deleted in History used to stay on the dashboard's tiles until
// someone pressed Refresh, because the write invalidated the session lists and
// not the KPI query. These tests hold every record write to refreshing both.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: apiMock }))

const mutations = await import('./mutations')

describe('a write to the inspection record refreshes the dashboard too', () => {
  let qc: QueryClient
  let invalidate: ReturnType<typeof vi.fn>
  /** The query keys the call under test asked to be refetched, as plain strings. */
  const keysInvalidated = () =>
    invalidate.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey: unknown[] } | undefined)?.queryKey ?? []))

  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockResolvedValue({ id: 's1', sampleId: 'sm1', version: 1 })
    qc = new QueryClient()
    invalidate = vi.fn().mockResolvedValue(undefined)
    qc.invalidateQueries = invalidate as unknown as QueryClient['invalidateQueries']
  })

  const cases: [string, () => Promise<unknown>][] = [
    ['deleteSession', () => mutations.deleteSession(qc, 's1')],
    ['deleteSample', () => mutations.deleteSample(qc, 'sm1')],
    ['discardSession', () => mutations.discardSession(qc, 's1')],
    ['closeSession', () => mutations.closeSession(qc, 's1', { version: 1, finalQty: 10 })],
    ['reopenSession', () => mutations.reopenSession(qc, 's1', 1)],
    ['deleteNote', () => mutations.deleteNote(qc, 's1', 'n1')],
    ['saveSample', () => mutations.saveSample(qc, 's1', { submissionId: 'x', drawing: 'D', sampleQty: 1, dimensions: [], defects: [], coils: [] })],
    ['startSession', () => mutations.startSession(qc, { orderId: 'o1', startQty: 0 })],
    ['correctDimension', () => mutations.correctDimension(qc, 'd1', { version: 1, actual: 1 })],
    ['correctDefect', () => mutations.correctDefect(qc, 'd1', { version: 1, qty: 1, disposition: 'Repair' })],
    ['clearOrders', () => mutations.clearOrders(qc)],
  ]

  for (const [name, run] of cases) {
    it(`${name} invalidates both the record and the dashboard`, async () => {
      await run()
      const keys = keysInvalidated()
      expect(keys, `${name} must refresh the dashboard`).toContain('["kpi"]')
      expect(keys, `${name} must refresh the session lists`).toContain('["sessions"]')
    })
  }

  it('an import refreshes the dashboard as well as the list it filled', async () => {
    apiMock.mockResolvedValue({ inserted: 1, updated: 0, skipped: 0 })
    await mutations.importRows(qc, 'orders', [{}])
    expect(keysInvalidated()).toEqual(expect.arrayContaining(['["orders"]', '["kpi"]']))
  })

  it('a production record import (§24) goes to its own importer and refreshes its summary', async () => {
    apiMock.mockResolvedValue({ inserted: 1, updated: 0 })
    await mutations.importRows(qc, 'production-records', [{ lineKey: '490226', erpRecordId: '113290' }])
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe('/production-records/import')
    expect(keysInvalidated()).toEqual(expect.arrayContaining(['["production-records"]']))
  })

  it('a machine edited in Configuration refreshes the dashboard', async () => {
    apiMock.mockResolvedValue({ id: 'm1' })
    await mutations.updateMaster(qc, 'machines', 'm1', {
      code: '31',
      name: 'Roll Forming',
      displayName: '31-Roll Forming-LM2',
      line: 'LM2',
      process: 'forming',
      usesItemDimensions: true,
      onDashboard: true,
    })
    expect(keysInvalidated()).toEqual(expect.arrayContaining(['["master","machines"]', '["kpi"]']))
  })
})
