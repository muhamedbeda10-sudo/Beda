import { describe, expect, it, vi } from 'vitest'
import { createUpdateGate } from './appUpdate'

describe('a new version waits for unsaved work', () => {
  it('is applied at once when nothing is being typed', () => {
    const gate = createUpdateGate()
    const apply = vi.fn()
    gate.whenFree(apply)
    expect(apply).toHaveBeenCalledOnce()
  })

  it('waits while a wizard is open, and is applied when the person leaves it', () => {
    const gate = createUpdateGate()
    const leaveWizard = gate.hold()
    const apply = vi.fn()
    gate.whenFree(apply)
    expect(apply).not.toHaveBeenCalled()
    expect(gate.held).toBe(true)
    leaveWizard()
    expect(apply).toHaveBeenCalledOnce()
    // Released twice (an effect cleaned up again) it neither throws nor applies twice.
    leaveWizard()
    expect(apply).toHaveBeenCalledOnce()
  })

  it('waits for the last of several screens with unsaved work', () => {
    const gate = createUpdateGate()
    const wizard = gate.hold()
    const dialog = gate.hold()
    const apply = vi.fn()
    gate.whenFree(apply)
    wizard()
    expect(apply).not.toHaveBeenCalled()
    dialog()
    expect(apply).toHaveBeenCalledOnce()
  })

  it('applies only the latest request: a reload into a version another tab swapped in replaces the swap', () => {
    const gate = createUpdateGate()
    const release = gate.hold()
    const swap = vi.fn()
    const reload = vi.fn()
    gate.whenFree(swap)
    gate.whenFree(reload)
    release()
    expect(swap).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledOnce()
    // Nothing is left waiting: a later hold and release does nothing.
    gate.hold()()
    expect(reload).toHaveBeenCalledOnce()
  })
})
