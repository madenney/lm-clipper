/** @jest-environment node */
import path from 'path'
import {
  LunarClip,
  clipSearchBody,
  clipToInterface,
  defaultClipSearch,
  parseLunarClips,
  validateClipSearch,
} from '../constants/clipSearch'
import { fileProcessor } from '../models/File'
import slpParser from '../models/methods/slpParser'

const REPLAY = path.resolve(__dirname, '../../assets/test.slp')

const clip = (over: Partial<LunarClip> = {}): LunarClip => ({
  id: 'c1',
  replayId: 'a'.repeat(24),
  type: 'combo',
  startFrame: 100,
  endFrame: 200,
  stageId: 31,
  startAt: '2026-09-28T20:00:00.000Z',
  attacker: {
    port: 0,
    characterId: 2,
    connectCode: 'FOX#1',
    displayName: 'Fox',
  },
  victim: {
    port: 1,
    characterId: 9,
    connectCode: 'MAR#1',
    displayName: 'Marth',
  },
  startPercent: 0,
  endPercent: 80,
  damage: 80,
  moves: 2,
  didKill: true,
  score: null,
  metrics: null,
  moveList: [
    [17, 100, 12, 1],
    [21, 150, 68, 1],
  ],
  ...over,
})

describe('clip search filters', () => {
  it('normalises renderer filters and builds the request', () => {
    const f = validateClipSearch({
      ...defaultClipSearch,
      attackerCharacterId: ['2', '2', 'x'],
      attackerConnectCode: ' MANG#0 ',
      minDamage: '60',
    })
    expect(f.attackerCharacterId).toEqual(['2'])
    expect(f.attackerConnectCode).toBe('MANG#0')
    expect(clipSearchBody(f, 3)).toMatchObject({
      type: 'combo',
      minDamage: '60',
      page: 3,
      limit: 25,
      withMoves: true,
    })
    // Kill / zero-to-death only apply to combos; damage not to edgeguards.
    const eg = clipSearchBody({ ...f, type: 'edgeguard', killOnly: true }, 1)
    expect(eg.killOnly).toBeUndefined()
    expect(eg.minDamage).toBeUndefined()
  })

  it('sends the opponent and tournaments', () => {
    const f = validateClipSearch({
      ...defaultClipSearch,
      victimConnectCode: 'ZAIN#0, HBOX#305',
      tournaments: ['kotj-7', 'kotj-7'],
    })
    expect(clipSearchBody(f, 1)).toMatchObject({
      victimConnectCode: 'ZAIN#0,HBOX#305',
      tournament: ['kotj-7'],
    })
    // Saved searches from before these fields still load.
    const { victimConnectCode: _v, tournaments: _t, ...old } = defaultClipSearch
    expect(validateClipSearch(old)).toMatchObject({
      victimConnectCode: '',
      tournaments: [],
    })
    expect(
      clipSearchBody(validateClipSearch(old), 1).tournament,
    ).toBeUndefined()
  })

  it('rejects bad filters', () => {
    expect(() => validateClipSearch({ type: 'everything' })).toThrow()
    expect(() =>
      validateClipSearch({ ...defaultClipSearch, minDamage: '1; drop' }),
    ).toThrow()
    expect(() =>
      validateClipSearch({ ...defaultClipSearch, tournaments: ['../x'] }),
    ).toThrow()
  })
})

describe('minimum hits and page size', () => {
  it('sends minMoves for combos only, and checks it is a whole number', () => {
    const f = { ...defaultClipSearch, minHits: '8' }
    expect(clipSearchBody(f, 1)).toMatchObject({ minMoves: '8', limit: 25 })
    expect(
      clipSearchBody({ ...f, type: 'edgeguard' }, 1).minMoves,
    ).toBeUndefined()
    expect(clipSearchBody(f, 2, 100).limit).toBe(100)
    expect(clipSearchBody(f, 1, 5000).limit).toBe(100)
    expect(validateClipSearch(f).minHits).toBe('8')
    expect(validateClipSearch({ ...f, minHits: undefined }).minHits).toBe('')
    expect(() => validateClipSearch({ ...f, minHits: '8.5' })).toThrow()
  })
})

describe('parseLunarClips', () => {
  it('accepts clips from the search', () => {
    expect(parseLunarClips([clip()])).toHaveLength(1)
  })

  it('rejects anything malformed', () => {
    expect(() => parseLunarClips([])).toThrow()
    expect(() => parseLunarClips([clip({ replayId: '../../x' })])).toThrow()
    expect(() =>
      parseLunarClips([clip({ moveList: [[1, 2, 3] as never] })]),
    ).toThrow()
    expect(() =>
      parseLunarClips(Array.from({ length: 501 }, () => clip())),
    ).toThrow(/at most 500/)
  })
})

describe('clipToInterface', () => {
  it('makes a combo row like the Combo Parser', () => {
    const row = clipToInterface(clip(), '/lib/a.slp')
    expect(row).toMatchObject({
      path: '/lib/a.slp',
      stage: 31,
      startFrame: 100,
      endFrame: 200,
      startedAt: 1790625600,
      comboer: {
        playerIndex: 0,
        port: 1,
        characterId: 2,
        connectCode: 'FOX#1',
      },
      comboee: { playerIndex: 1, characterId: 9 },
      combo: {
        startPercent: 0,
        endPercent: 80,
        didKill: true,
        moves: [
          { playerIndex: 0, frame: 100, moveId: 17, hitCount: 1, damage: 12 },
          { playerIndex: 0, frame: 150, moveId: 21, hitCount: 1, damage: 68 },
        ],
      },
      lunarClip: { id: 'c1', replayId: 'a'.repeat(24), type: 'combo' },
    })
  })

  it('carries edgeguard score and metrics, and marks quit-outs', () => {
    const eg = clipToInterface(
      clip({ type: 'edgeguard', score: 7, metrics: { hits: 3, score: 7 } }),
      '/x.slp',
    )
    expect(eg.edgeguardScore).toBe(7)
    expect(eg.edgeguardMetrics).toMatchObject({ hits: 3 })
    expect(eg.combo).toBeUndefined()
    const q = clipToInterface(
      clip({ type: 'quitout', endFrame: null, gameFrames: 900 }),
      '/x.slp',
    )
    expect(q.combo?.earlyQuit).toBe(true)
    expect(q.endFrame).toBe(900)
  })

  it('matches the Combo Parser exactly on a real replay', () => {
    const file = fileProcessor(REPLAY)
    const params = {
      minHits: '',
      maxHits: '',
      maxFiles: '',
      comboTimeout: '',
      comboerChar: [],
      comboeeChar: [],
      comboerTag: [],
      comboerCC: [],
      comboeeTag: [],
      comboeeCC: [],
      didKill: false,
    }
    const { combos } = slpParser(file, params as never)
    expect(combos.length).toBeGreaterThan(0)
    for (const own of combos) {
      // The same combo as the database stores it in its clips index.
      const fromDb = clip({
        startFrame: own.startFrame,
        endFrame: own.endFrame || null,
        stageId: own.stage,
        startAt: new Date((own.startedAt as number) * 1000).toISOString(),
        attacker: {
          port: own.comboer!.playerIndex,
          characterId: own.comboer!.characterId,
          connectCode: null,
          displayName: null,
        },
        victim: {
          port: own.comboee!.playerIndex,
          characterId: own.comboee!.characterId,
          connectCode: null,
          displayName: null,
        },
        startPercent: own.combo!.startPercent,
        endPercent: own.combo!.endPercent ?? null,
        didKill: own.combo!.didKill,
        moveList: own.combo!.moves!.map((m) => [
          m.moveId,
          m.frame,
          m.damage,
          m.hitCount,
        ]),
      })
      const { lunarClip: _l, ...converted } = clipToInterface(
        fromDb,
        REPLAY,
        file.players,
      )
      expect(converted).toEqual(own)
    }
  })
})
