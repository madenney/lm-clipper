/**
 * @jest-environment node
 *
 * Filter fixes from the launch review (FLT-3, 4, 5, 10, 13, 14, 19): small
 * pure-ish checks that need no database. The detectors themselves are covered
 * by the shared-package tests.
 */
import { parseSemicolonParam, matchesPlayer, maxOf } from '../lib/filterHelpers'
import deduplicate from '../models/methods/deduplicate'
import trim from '../models/methods/trim'
import { getSortOrderExpr } from '../models/methods/sort'
import { FILTER_TRAITS, traitsOf } from '../models/filterTraits'

// A fake game: frames by number, optional metadata.
const fakeGames: Record<
  string,
  { frames?: any; metadata?: any; throws?: boolean }
> = {}
jest.mock('../lib/slippiGame', () => ({
  SlippiGame: class {
    private g: { frames?: any; metadata?: any; throws?: boolean }

    constructor(p: string) {
      const g = fakeGames[p]
      if (!g || g.throws) throw new Error(`cannot open ${p}`)
      this.g = g
    }

    getFrames() {
      return this.g.frames
    }

    getMetadata() {
      return this.g.metadata
    }
  },
}))
jest.mock('../lib/slippiStocks', () => ({ computeStocks: () => [] }))

// eslint-disable-next-line import/first
import actionStateFilter from '../models/methods/actionStateFilter'
// eslint-disable-next-line import/first
import koDirection from '../models/methods/koDirection'
// eslint-disable-next-line import/first
import reverse from '../models/methods/reverse'

const emit = () => {}
const clip = (over: Record<string, unknown> = {}) =>
  ({
    path: '/g.slp',
    stage: 31,
    startedAt: 1000,
    startFrame: 100,
    endFrame: 200,
    comboer: { playerIndex: 0, characterId: 2 },
    comboee: { playerIndex: 1, characterId: 20 },
    ...over,
  }) as any

describe('Deduplicate (FLT-3)', () => {
  it('removes duplicates farther apart than one chunk, because the set lives across chunks', () => {
    const params = {} as any
    const a = clip()
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        clip({ startedAt: 5000 + i, startFrame: i }),
      )
    // Chunk 1 holds the first copy, chunk 2 (same params object) the second.
    const first = deduplicate([a, ...filler(5)], params, emit)
    const second = deduplicate([...filler(5).slice(0, 2), clip()], params, emit)
    expect(first).toHaveLength(6)
    expect(second.some((c: any) => c.startedAt === 1000)).toBe(false)
  })

  it('a different run (new params object) starts with nothing seen', () => {
    expect(deduplicate([clip()], {} as any, emit)).toHaveLength(1)
    expect(deduplicate([clip()], {} as any, emit)).toHaveLength(1)
  })

  it('does not merge clips that have no start time', () => {
    const out = deduplicate(
      [
        clip({ startedAt: 0 }),
        clip({ startedAt: 0 }),
        clip({ startedAt: undefined }),
      ],
      {} as any,
      emit,
    )
    expect(out).toHaveLength(3)
  })

  it('runs on one worker and restarts a stopped run, like sort and range', () => {
    expect(traitsOf('deduplicate').singleWorker).toBe(true)
    for (const type of ['deduplicate', 'sort', 'randomSample', 'range'])
      expect(FILTER_TRAITS[type].restartOnResume).toBe(true)
    expect(FILTER_TRAITS.comboFilter.restartOnResume).toBeFalsy()
  })
})

describe('Trim on a combo still open when the game ended (FLT-4)', () => {
  it('leaves an open end (endFrame 0) alone instead of making a 1-frame clip', () => {
    const [open] = trim([clip({ endFrame: 0 })], { addEndFrames: '60' } as any)
    expect(open.endFrame).toBe(0)
    const [moved] = trim([clip({ endFrame: 0 })], {
      addStartFrames: '30',
      addEndFrames: '60',
    } as any)
    expect(moved.startFrame).toBe(70)
    expect(moved.endFrame).toBe(0)
  })

  it('still extends a normal clip and keeps it at least a frame long', () => {
    const [a] = trim([clip()], { addEndFrames: '60' } as any)
    expect(a.endFrame).toBe(260)
    const [b] = trim([clip()], { addEndFrames: '-500' } as any)
    expect(b.endFrame).toBe(b.startFrame + 1)
  })
})

describe('Action State Filter without metadata (FLT-5)', () => {
  const frames = (until: number, state: number) =>
    Object.fromEntries(
      Array.from({ length: until }, (_, i) => [
        i - 123,
        {
          frame: i - 123,
          players: { 0: { post: { playerIndex: 0, actionStateId: state } } },
        },
      ]),
    )
  const params = (over: Record<string, unknown> = {}) =>
    ({
      comboerActionState: [101], // Shine
      ...over,
    }) as any

  it('finds a state in a replay that has no lastFrame in its metadata', () => {
    fakeGames['/stripped.slp'] = { frames: frames(600, 360), metadata: null }
    const out = actionStateFilter(
      [clip({ path: '/stripped.slp' })],
      params(),
      emit,
    )
    expect(out).toHaveLength(1)
  })

  it('Exclude drops that game (it used to keep every stripped replay)', () => {
    fakeGames['/stripped.slp'] = { frames: frames(600, 360), metadata: {} }
    const out = actionStateFilter(
      [clip({ path: '/stripped.slp' })],
      params({ exclude: true }),
      emit,
    )
    expect(out).toHaveLength(0)
  })

  it('still agrees with metadata when it is there', () => {
    fakeGames['/with.slp'] = {
      frames: frames(600, 14),
      metadata: { lastFrame: 476 },
    }
    expect(
      actionStateFilter([clip({ path: '/with.slp' })], params(), emit),
    ).toHaveLength(0)
  })
})

describe('a missing or corrupt replay skips the clip, never fails the run (FLT-10)', () => {
  beforeEach(() => {
    fakeGames['/bad.slp'] = { throws: true }
  })
  it('Action State, KO direction and Reverse Hits do not throw', () => {
    const bad = clip({
      path: '/bad.slp',
      combo: { didKill: true, moves: [{ frame: 1, damage: 5, moveId: 1 }] },
    })
    expect(() =>
      actionStateFilter([bad], { comboerActionState: [101] } as any, emit),
    ).not.toThrow()
    expect(() => koDirection([bad], { direction: ['up'] } as any)).not.toThrow()
    expect(koDirection([bad], { direction: ['up'] } as any)).toEqual([])
    expect(() => reverse([bad], { n: '1' } as any, emit)).not.toThrow()
  })
})

describe('tag and connect-code matching (FLT-13)', () => {
  it('trims, lowercases and drops empty entries', () => {
    expect(parseSemicolonParam('Mang0; Zain ;')).toEqual(['mang0', 'zain'])
    expect(parseSemicolonParam(['A ', ' ', 'b'])).toEqual(['a', 'b'])
    expect(parseSemicolonParam(';')).toEqual([])
    expect(parseSemicolonParam(undefined)).toEqual([])
  })

  it('a trailing ";" does not match a player with an empty name', () => {
    expect(
      matchesPlayer({ characterId: 1, displayName: '' }, [], 'mang0;', ''),
    ).toBe(false)
    expect(
      matchesPlayer(
        { characterId: 1, displayName: 'Zain' },
        [],
        'mang0; zain',
        '',
      ),
    ).toBe(true)
  })
})

describe('long games (FLT-14)', () => {
  it('maxOf does not overflow the call stack on 300k frame numbers', () => {
    const many = Array.from({ length: 300_000 }, (_, i) => i - 123)
    expect(() => Math.max(...many)).toThrow()
    expect(maxOf(many)).toBe(299_876)
    expect(maxOf([])).toBe(0)
  })
})

describe('sort ties (FLT-19)', () => {
  it('chronological order falls back to the position in the game', () => {
    const expr = getSortOrderExpr('chronological', false)!
    expect(expr).toMatch(/startedAt.*ASC, .*startFrame.*ASC/)
    expect(getSortOrderExpr('chronological', true)).toMatch(
      /startedAt.*DESC, .*startFrame.*DESC/,
    )
  })
})
