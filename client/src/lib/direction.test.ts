import { describe, expect, it } from 'vitest'
import { messageDirection, textDirection } from './direction'

describe('which way a chat message reads', () => {
  it('reads an Arabic message naming English parts right to left, even when it opens with one', () => {
    const message = 'welding wire تحت\nضروري Connector welding wire\nفي مكان اللحام'
    // Its first strong letter is Latin: dir="auto" would set it left to right.
    expect(textDirection(message)).toBe('ltr')
    expect(messageDirection(message)).toBe('rtl')
    expect(messageDirection('ضروري Connector welding wire في مكان اللحام')).toBe('rtl')
  })

  it('reads an English message with a few Arabic words left to right, and says nothing of one without letters', () => {
    expect(messageDirection('Please check the coil grade قبل البدء')).toBe('ltr')
    expect(messageDirection('Sample 12 failed on RF-03')).toBe('ltr')
    expect(messageDirection('العينة 12 فشلت')).toBe('rtl')
    expect(messageDirection('123 — 45% 👍')).toBeNull()
    expect(messageDirection('')).toBeNull()
  })
})
