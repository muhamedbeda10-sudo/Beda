import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { failureMessage, guarded, singleFlight } from './busyAction'

/** A promise the test settles by hand. */
function later<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('one action at a time', () => {
  it('ignores a second tap while the first is under way, and takes the next once it is done', async () => {
    const flight = singleFlight()
    const gate = later()
    let calls = 0
    const work = async () => {
      calls++
      await gate.promise
      return 'closed'
    }
    const first = flight.run(work)
    const second = flight.run(work)
    expect(flight.running).toBe(true)
    expect(await second).toBeUndefined()
    gate.resolve()
    expect(await first).toBe('closed')
    expect(calls).toBe(1)
    expect(flight.running).toBe(false)
    await flight.run(async () => undefined)
    expect(calls).toBe(1)
    await flight.run(work)
    expect(calls).toBe(2)
  })

  it('lets go after a failure, so the person can try again', async () => {
    const flight = singleFlight()
    await expect(flight.run(async () => Promise.reject(new Error('refused')))).rejects.toThrow('refused')
    expect(flight.running).toBe(false)
    expect(await flight.run(async () => 'again')).toBe('again')
  })

  it('keeps the dialog’s reason when closing fails, and the dialog open — only success lets it close', async () => {
    const flight = singleFlight()
    const busy: boolean[] = []
    let error: string | null = 'old'
    let dialogOpen = true
    // The board's close: it closes the dialog only after the server said yes.
    const closeSession = (answer: () => Promise<void>) => async () => {
      await answer()
      dialogOpen = false
    }
    const refused = await guarded(flight, closeSession(() => Promise.reject(new ApiError(409, 'conflict', 'Someone changed this session.'))), 'Could not close the session.', (b) => busy.push(b), (e) => (error = e))
    expect(refused).toBe(false)
    expect(dialogOpen).toBe(true)
    expect(error).toBe('Someone changed this session.')
    expect(busy).toEqual([true, false])

    const gate = later()
    const first = guarded(flight, closeSession(() => gate.promise), 'Could not close the session.', (b) => busy.push(b), (e) => (error = e))
    // A second tap while the first is under way does nothing.
    expect(await guarded(flight, closeSession(async () => undefined), 'x', () => undefined, () => undefined)).toBe(false)
    gate.resolve()
    expect(await first).toBe(true)
    expect(error).toBeNull()
    expect(dialogOpen).toBe(false)
  })

  it('says why it failed in the server’s words, a dead network plainly, anything else as given', () => {
    expect(failureMessage(new ApiError(409, 'conflict', 'Someone changed this session.'), 'Could not close.')).toBe('Someone changed this session.')
    expect(failureMessage(new ApiError(0, 'internal', 'x'), 'Could not close.')).toBe('Network error — check your connection.')
    expect(failureMessage('weird', 'Could not close.')).toBe('Could not close.')
  })
})
