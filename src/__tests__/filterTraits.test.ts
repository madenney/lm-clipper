/** @jest-environment node */
import { filtersConfig } from '../constants/config'
import methods from '../models/methods'
import { FILTER_TRAITS, traitsOf } from '../models/filterTraits'

// Every filter type is declared once, in FILTER_TRAITS (structure review E13).
describe('filter traits', () => {
  const configured = (filtersConfig as { id: string }[]).map((f) => f.id)

  it('cover every filter type the app offers', () => {
    expect(configured.filter((id) => !FILTER_TRAITS[id])).toEqual([])
  })

  it('cover every filter method', () => {
    expect(Object.keys(methods).filter((id) => !FILTER_TRAITS[id])).toEqual([])
  })

  it('give every chunked or parser type a method (pressure is parked)', () => {
    const missing = Object.entries(FILTER_TRAITS)
      .filter(([, t]) => t.run === 'chunks' || t.run === 'parser')
      .map(([id]) => id)
      .filter((id) => !(id in methods))
    expect(missing).toEqual(['pressure'])
  })

  it('run the whole input on one worker for order- and position-based types', () => {
    for (const id of ['sort', 'randomSample', 'range'])
      expect(traitsOf(id).singleWorker).toBe(true)
  })
})
