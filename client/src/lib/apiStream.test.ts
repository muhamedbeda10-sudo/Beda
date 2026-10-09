import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiStream, setAccessToken, setSessionLostHandler } from './api'

const sse = () => new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
  setAccessToken(null)
  setSessionLostHandler(null)
})

describe('apiStream', () => {
  it('posts JSON with the bearer token and hands back the open stream', async () => {
    const fetchMock = vi.fn(async () => sse())
    vi.stubGlobal('fetch', fetchMock)
    setAccessToken('t1')
    const body = await apiStream('/ai/chat', { body: { message: 'hi', clientId: 'c-12345678' } })
    expect(body).toBeInstanceOf(ReadableStream)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/ai/chat')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t1')
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi', clientId: 'c-12345678' })
  })

  it('refreshes an expired token once and sends again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthenticated', message: 'Expired.' } }))
      .mockResolvedValueOnce(json(200, { accessToken: 't2' }))
      .mockResolvedValueOnce(sse())
    vi.stubGlobal('fetch', fetchMock)
    setAccessToken('t1')
    await apiStream('/ai/chat', { body: {} })
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual(['/api/ai/chat', '/api/auth/refresh', '/api/ai/chat'])
    expect(((fetchMock.mock.calls[2][1] as RequestInit).headers as Record<string, string>).authorization).toBe('Bearer t2')
  })

  it('throws the server’s refusal as an ApiError before any stream is read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(402, { error: { code: 'ai_budget_reached', message: "This month's budget is spent." } })))
    const err = await apiStream('/ai/chat', { body: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 402, code: 'ai_budget_reached', message: "This month's budget is spent." })
  })

  it('signs out when the refresh fails', async () => {
    const lost = vi.fn()
    setSessionLostHandler(lost)
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'unauthenticated', message: 'No.' } })))
    await expect(apiStream('/ai/chat', { body: {} })).rejects.toMatchObject({ status: 401 })
    expect(lost).toHaveBeenCalledOnce()
  })

  it('reports a dead network plainly, and lets an abort through as it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(apiStream('/ai/chat', { body: {} })).rejects.toMatchObject({ status: 0, message: 'Network error — check your connection.' })
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)))
    await expect(apiStream('/ai/chat', { body: {} })).rejects.toBe(abort)
  })
})
