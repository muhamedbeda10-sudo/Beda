import { describe, expect, it } from 'vitest'
import { boardViewFor, factorySwitch, offersFactoryChoice, type FactoryCount } from './boardLayout'

const f = (label: string, count: number, key = label): FactoryCount => ({ key, label, count })

describe('the board’s factory switch', () => {
  it('offers the factories with something open, the busiest first, ties by name in number order', () => {
    const register = [f('Factory 1', 0), f('Factory 10', 2), f('Factory 2', 2), f('Factory 3', 5), f('No factory', 1, '__none__')]
    expect(factorySwitch(register, 'all').map((t) => t.label)).toEqual(['Factory 3', 'Factory 2', 'Factory 10', 'No factory'])
  })

  it('keeps the chosen factory when the inspector filter leaves nothing open in it, so the choice can be undone', () => {
    const register = [f('Factory 1', 0), f('Factory 3', 2)]
    expect(factorySwitch(register, 'Factory 1').map((t) => t.label)).toEqual(['Factory 3', 'Factory 1'])
    expect(factorySwitch(register, 'all').map((t) => t.label)).toEqual(['Factory 3'])
  })

  it('does not reorder or change what it was given', () => {
    const register = [f('B', 1), f('A', 3)]
    const copy = register.map((t) => ({ ...t }))
    factorySwitch(register, 'all')
    expect(register).toEqual(copy)
  })

  it('shows only when there is a choice: two factories with work, or a factory chosen', () => {
    expect(offersFactoryChoice([f('Factory 3', 2)], 'all')).toBe(false)
    expect(offersFactoryChoice([], 'all')).toBe(false)
    expect(offersFactoryChoice([f('Factory 3', 2), f('Factory 1', 1)], 'all')).toBe(true)
    // The one factory with work, chosen: All must stay reachable.
    expect(offersFactoryChoice([f('Factory 3', 2)], 'Factory 3')).toBe(true)
  })
})

describe('the board’s view on each screen', () => {
  it('shows the table as the compact list on a phone, and as the table again on a wider screen', () => {
    expect(boardViewFor('table', true)).toBe('compact')
    expect(boardViewFor('table', false)).toBe('table')
  })

  it('leaves the cards and the compact list as they are everywhere', () => {
    for (const phone of [true, false]) {
      expect(boardViewFor('cards', phone)).toBe('cards')
      expect(boardViewFor('compact', phone)).toBe('compact')
    }
  })
})
