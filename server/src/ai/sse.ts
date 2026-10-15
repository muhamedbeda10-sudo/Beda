// ============================================================================
// §20 — Server-Sent Events for an answer being written. One event per
// AiStreamEvent, named by its `type`; a comment line every 15 s keeps proxies
// (App Service's front end drops a request that is silent for ~230 s) from
// closing a long answer.
//
// Once the headers are out, an error can no longer become a JSON response:
// the caller sends an `error` event and ends the stream instead.
// ============================================================================

import type { Response } from 'express'
import type { AiStreamEvent } from '@qc/shared/ai'

const HEARTBEAT_MS = 15_000

export class SseStream {
  private heartbeat: NodeJS.Timeout | null = null

  constructor(private readonly res: Response) {}

  /** Send the headers now, so the browser sees the answer begin at once. */
  open(): void {
    this.res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: a compression layer must not hold the stream back.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    })
    this.res.flushHeaders()
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  /** False once the browser has gone or the stream has ended. */
  get writable(): boolean {
    return !this.res.writableEnded && !this.res.destroyed
  }

  /** One event, named by its `type`: an answer's (AiStreamEvent), or another stream's, such as a certificate being read (MTC). */
  send(event: AiStreamEvent | { type: string }): void {
    // JSON.stringify escapes line breaks, so the data is always one line.
    this.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  end(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.writable) this.res.end()
  }

  private write(chunk: string): void {
    if (this.writable) this.res.write(chunk)
  }
}
