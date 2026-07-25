import { describe, it, expect } from 'vitest'
import { sniffImageMime, sha256Hex, buildStorageKey } from './imageStore'

const bytes = (...b: number[]) => new Uint8Array(b)

describe('§10.4 content sniffing', () => {
  it('detects JPEG from its magic bytes', () => {
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe('image/jpeg')
  })

  it('detects PNG from its magic bytes', () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
  })

  it('detects GIF and WebP', () => {
    expect(sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(
      sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)),
    ).toBe('image/webp')
  })

  it('detects HEIC from the ftyp brand', () => {
    expect(
      sniffImageMime(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63)),
    ).toBe('image/heic')
  })

  it('rejects a non-image even when it would be named .jpg', () => {
    // "%PDF" — a PDF renamed to photo.jpg must not pass.
    expect(sniffImageMime(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31))).toBeNull()
    // a shell script
    expect(sniffImageMime(bytes(0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e))).toBeNull()
  })

  it('rejects an empty or truncated file', () => {
    expect(sniffImageMime(bytes())).toBeNull()
    expect(sniffImageMime(bytes(0xff))).toBeNull()
  })
})

describe('§10 content hashing', () => {
  it('produces the known SHA-256 of an empty input', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('produces the known SHA-256 of "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('gives identical bytes the same hash and different bytes a different one', async () => {
    const a = await sha256Hex(new TextEncoder().encode('evidence'))
    const b = await sha256Hex(new TextEncoder().encode('evidence'))
    const c = await sha256Hex(new TextEncoder().encode('evidence.'))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('§10.2 / §10.3 generated storage keys', () => {
  it('never lets two uploads of the same filename collide', () => {
    const k1 = buildStorageKey({ id: 'img_1', sessionId: 's1' })
    const k2 = buildStorageKey({ id: 'img_2', sessionId: 's1' })
    expect(k1).not.toBe(k2)
  })

  it('does not embed the client filename in the key', () => {
    const key = buildStorageKey({ id: 'img_1', sessionId: 's1' })
    expect(key).not.toContain('defect')
    expect(key).toMatch(/^images\/sessions\/s1\/img_1\.jpg$/)
  })

  it('scopes by session, then order, then falls back', () => {
    expect(buildStorageKey({ id: 'i', sessionId: 's1', orderId: 'o1' })).toContain('sessions/s1')
    expect(buildStorageKey({ id: 'i', orderId: 'o1' })).toContain('orders/o1')
    expect(buildStorageKey({ id: 'i' })).toContain('unscoped')
  })
})
