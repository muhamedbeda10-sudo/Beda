// ============================================================================
// §10 — the system owns the bytes. Two drivers implement one contract:
//
//   azure-blob  Azure Blob Storage (production). The container is private;
//               the API streams bytes to signed-in users.
//   local       files under server/data (development and tests only — an App
//               Service disk is not durable across deployments).
//
// Neither driver will ever overwrite an existing key (§10.3).
// ============================================================================

import { createReadStream } from 'node:fs'
import { access, mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import type { ImageDriver } from '@qc/shared/types'

export interface StoredImage {
  stream: Readable
  contentType: string
  byteSize?: number
}

export interface ImageStorage {
  readonly driver: ImageDriver
  /** Persist bytes under `key`. Throws if the key already exists. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  /** Bytes for a stored key, or null when nothing is stored there. */
  get(key: string): Promise<StoredImage | null>
  /** Remove bytes — only ever called to roll back a failed upload. */
  remove(key: string): Promise<void>
}

export class KeyExistsError extends Error {
  constructor(key: string) {
    super(`An image is already stored at ${key}`)
    this.name = 'KeyExistsError'
  }
}

/** The system generates stored names, never the client (§10.2). */
export function buildStorageKey(input: { id: string; sessionId?: string | null; orderId?: string | null }): string {
  const scope = input.sessionId ? `sessions/${input.sessionId}` : input.orderId ? `orders/${input.orderId}` : 'unscoped'
  return `images/${scope}/${input.id}.jpg`
}

/** Controlled documents (work instructions) share the store under their own prefix. */
export function buildDocumentStorageKey(id: string): string {
  return `documents/work-instructions/${id}.pdf`
}

function assertSafeKey(key: string): void {
  const ok = /^images\/[A-Za-z0-9_./-]+\.jpg$/.test(key) || /^documents\/[A-Za-z0-9_./-]+\.pdf$/.test(key)
  if (!ok || key.includes('..')) {
    throw new Error(`Refusing unsafe storage key: ${key}`)
  }
}

function contentTypeForKey(key: string): string {
  return key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
}

// ---- Local filesystem ------------------------------------------------------

export class LocalImageStorage implements ImageStorage {
  readonly driver = 'local' as const

  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    assertSafeKey(key)
    return path.join(this.rootDir, key)
  }

  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const file = this.resolve(key)
    await mkdir(path.dirname(file), { recursive: true })
    try {
      // 'wx' — fail if the file exists.
      await writeFile(file, bytes, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new KeyExistsError(key)
      throw e
    }
  }

  async get(key: string): Promise<StoredImage | null> {
    const file = this.resolve(key)
    try {
      await access(file)
    } catch {
      return null
    }
    return { stream: createReadStream(file), contentType: contentTypeForKey(key) }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
}

// ---- Azure Blob Storage ----------------------------------------------------

export class AzureBlobImageStorage implements ImageStorage {
  readonly driver = 'azure-blob' as const
  private readonly container: ContainerClient
  private ensured: Promise<void> | null = null

  constructor(connectionString: string, containerName: string) {
    this.container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName)
  }

  private ensureContainer(): Promise<void> {
    // Private container: no anonymous access. Created once per process.
    if (!this.ensured) this.ensured = this.container.createIfNotExists().then(() => undefined)
    return this.ensured
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key)
    await this.ensureContainer()
    const blob = this.container.getBlockBlobClient(key)
    try {
      await blob.uploadData(bytes, {
        blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'private, max-age=31536000, immutable' },
        // If-None-Match: * — the upload fails rather than replacing evidence.
        conditions: { ifNoneMatch: '*' },
      })
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 409 || status === 412) throw new KeyExistsError(key)
      throw e
    }
  }

  async get(key: string): Promise<StoredImage | null> {
    assertSafeKey(key)
    const blob = this.container.getBlockBlobClient(key)
    try {
      const res = await blob.download()
      const body = res.readableStreamBody
      if (!body) return null
      return {
        stream: body as unknown as Readable,
        contentType: res.contentType ?? contentTypeForKey(key),
        byteSize: res.contentLength,
      }
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null
      throw e
    }
  }

  async remove(key: string): Promise<void> {
    assertSafeKey(key)
    await this.container.getBlockBlobClient(key).deleteIfExists()
  }
}

// ---- Content sniffing ------------------------------------------------------

/** Detect the real type from magic bytes — never trust the declared type. */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
    return 'image/png'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'image/webp'
  return null
}
