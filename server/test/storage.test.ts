import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KeyExistsError, LocalImageStorage, buildStorageKey, sniffImageMime } from '../src/images/storage'
import { hashPassword, verifyPassword } from '../src/auth/password'
import { RateLimiter } from '../src/lib/rateLimit'

describe('§10.2 / §10.3 storage keys', () => {
  it('are unique per upload, so two "defect.jpg" files never collide', () => {
    const k1 = buildStorageKey({ id: 'a', sessionId: 's1' })
    const k2 = buildStorageKey({ id: 'b', sessionId: 's1' })
    expect(k1).not.toBe(k2)
  })
  it('scope by session, then order, then unscoped', () => {
    expect(buildStorageKey({ id: 'i', sessionId: 's1', orderId: 'o1' })).toContain('sessions/s1')
    expect(buildStorageKey({ id: 'i', orderId: 'o1' })).toContain('orders/o1')
    expect(buildStorageKey({ id: 'i' })).toContain('unscoped')
  })
})

describe('local image storage', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'qc-store-'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('stores, reads back, and refuses to overwrite', async () => {
    const store = new LocalImageStorage(dir)
    const key = buildStorageKey({ id: 'one', sessionId: 's' })
    await store.put(key, Buffer.from('hello'), 'image/jpeg')
    const got = await store.get(key)
    expect(got).not.toBeNull()
    const chunks: Buffer[] = []
    for await (const c of got!.stream) chunks.push(Buffer.from(c))
    expect(Buffer.concat(chunks).toString()).toBe('hello')
    await expect(store.put(key, Buffer.from('other'), 'image/jpeg')).rejects.toBeInstanceOf(KeyExistsError)
    expect(await store.get(buildStorageKey({ id: 'missing' }))).toBeNull()
  })

  it('rejects a key that escapes the image folder', async () => {
    const store = new LocalImageStorage(dir)
    await expect(store.put('images/../../etc/passwd.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/unsafe/)
  })
})

describe('content sniffing', () => {
  it('recognises JPEG, PNG and WebP and nothing else', () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull()
  })
})

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false)
    expect(await verifyPassword('anything', 'garbage')).toBe(false)
  })
  it('salts, so equal passwords hash differently', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })
})

describe('rate limiter', () => {
  it('allows max hits per window then blocks until the window ends', () => {
    const rl = new RateLimiter(3, 1000)
    expect(rl.hit('k', 0)).toBe(0)
    expect(rl.hit('k', 1)).toBe(0)
    expect(rl.hit('k', 2)).toBe(0)
    expect(rl.hit('k', 3)).toBeGreaterThan(0)
    expect(rl.hit('k', 1001)).toBe(0)
    expect(rl.hit('other', 3)).toBe(0)
  })
})
