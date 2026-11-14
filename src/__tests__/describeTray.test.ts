import {
  chainTo,
  describeTray,
  type TrayFilter,
  type TrayLive,
} from '../lib/describeTray'

const f = (
  over: Partial<TrayFilter> & { id: string; type: string },
): TrayFilter => ({
  label: over.type,
  isProcessed: true,
  params: {},
  results: 0,
  ...over,
})

const sentence = (
  filters: TrayFilter[],
  active: string,
  replays: number | null = null,
  live?: TrayLive,
) => {
  const d = describeTray(filters, active, replays, live)
  return `${d.lead}${d.focus ? ` ${d.focus}` : ''}${d.tail}`
}

const game = f({ id: 'g', type: 'files', label: 'Game Filter', results: 987 })
const parser = f({
  id: 'p',
  type: 'slpParser',
  label: 'Combo Parser',
  results: 5000,
  params: { minHits: '2' },
})
const combo = f({
  id: 'c',
  type: 'comboFilter',
  label: 'Combo Filter',
  results: 371,
  params: { minHits: '5', didKill: true },
})
const sort = f({
  id: 's',
  type: 'sort',
  label: 'Sort',
  results: 371,
  params: { sortFunction: 'dps' },
})
const chain = [game, parser, combo, sort]

describe('chainTo', () => {
  it('walks from the replays to the active step', () => {
    expect(chainTo(chain, 's').map((x) => x.id)).toEqual(['g', 'p', 'c', 's'])
    expect(chainTo(chain, 'p').map((x) => x.id)).toEqual(['g', 'p'])
  })
  it('follows a branch (inputId) rather than the step above', () => {
    const branched = [...chain, f({ id: 'x', type: 'sort', inputId: 'p' })]
    expect(chainTo(branched, 'x').map((x) => x.id)).toEqual(['g', 'p', 'x'])
  })
  it('is empty for an unknown step', () => {
    expect(chainTo(chain, 'nope')).toEqual([])
  })
})

describe('the tray sentence', () => {
  it('describes the replays before any step is picked', () => {
    expect(sentence(chain, 'files', 5000)).toBe('Showing 5,000 games')
  })
  it('stays short high in the chain and grows down it', () => {
    expect(sentence(chain, 'g')).toBe('Showing 987 games')
    expect(sentence(chain, 'p')).toBe('Showing 5,000 combos, 2 hits min')
    expect(sentence(chain, 'c')).toBe(
      'Showing 371 combos, ending in a kill, 5 hits min',
    )
    expect(sentence(chain, 's')).toBe(
      'Showing 371 combos, ending in a kill, 5 hits min, sorted by DPS',
    )
  })
  it('names characters, stages and the sort direction', () => {
    const g = f({
      id: 'g',
      type: 'files',
      results: 10,
      params: { char1: [2], stage: [31] },
    })
    const s = f({
      id: 's',
      type: 'sort',
      results: 10,
      params: { sortFunction: 'length', reverse: true },
    })
    expect(sentence([g, s], 'g')).toBe(
      'Showing 10 games with Fox, on Battlefield',
    )
    expect(sentence([g, s], 's')).toBe(
      'Showing 10 clips, in games with Fox, on Battlefield, sorted by clip length, reversed',
    )
  })
  it('says one, not ones, for a single result', () => {
    expect(sentence([game, { ...parser, results: 1 }], 'p')).toBe(
      'Showing 1 combo, 2 hits min',
    )
  })
  it('caps the clauses and counts the rest', () => {
    const busy = [
      f({
        id: 'g',
        type: 'files',
        results: 9,
        params: { char1: [2], stage: [31], includeCpu: true },
      }),
      f({
        id: 'p',
        type: 'slpParser',
        results: 9,
        params: { minHits: '3', comboerChar: [20] },
      }),
      f({ id: 'd', type: 'deduplicate', results: 9 }),
      f({ id: 'a', type: 'afkDetection', results: 9, params: {} }),
    ]
    const text = sentence(busy, 'a')
    expect(text).toMatch(/more settings$/)
    expect(text.split(', ').length).toBeLessThanOrEqual(6)
  })
  it('moves with a running step: its count so far, with its settings', () => {
    const live = { running: new Set(['p']), counts: { p: 12345 } }
    expect(sentence(chain, 'p', null, live)).toBe(
      'Combo Parser is running: 12,345 combos so far, 2 hits min',
    )
    expect(
      sentence(chain, 'p', null, { running: new Set(['p']), counts: {} }),
    ).toBe('Combo Parser is running…')
  })
  it('says a later step is waiting while one above it runs', () => {
    const waiting = [
      game,
      parser,
      { ...combo, isProcessed: false, results: null },
    ]
    expect(
      sentence(waiting, 'c', null, { running: new Set(['p']), counts: {} }),
    ).toBe('Waiting for Combo Parser to finish…')
  })
  it('says plainly what is true for a step that has not run, and that it is counting', () => {
    expect(
      sentence([game, { ...combo, isProcessed: false, results: null }], 'c'),
    ).toBe("Combo Filter hasn't run yet, so the tray is empty.")
    expect(sentence([{ ...game, results: null }], 'g')).toBe('Counting games…')
  })
})
