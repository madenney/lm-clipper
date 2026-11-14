/**
 * @jest-environment node
 *
 * Find replays' times and copy: every game it offers is stored on storage
 * (storedOnly), so every download comes straight from storage, one by one up to
 * ONE_BY_ONE_MAX_GAMES and by range after that. Nothing comes from the Lunar server.
 */
import {
  ONE_BY_ONE_MAX_GAMES,
  databaseExportFilter,
  databaseSearchBody,
  defaultDatabaseFilters,
  estimateFromStored,
  parseFullDbInfo,
  storageDownloadText,
  storageSeconds,
  storedThroughNote,
} from '../constants/database'
import { clipSearchBody, findClipsBody } from '../constants/clipSearch'
import * as databaseConstants from '../constants/database'

describe('storage-speed times', () => {
  it('one by one up to 24 games, ~5 a second', () => {
    expect(ONE_BY_ONE_MAX_GAMES).toBe(24)
    expect(storageSeconds(10, 450_000)).toBe(2)
    expect(storageSeconds(24, 450_000)).toBeCloseTo(4.8, 5)
    expect(storageSeconds(0, 450_000)).toBe(0)
  })

  it('by range from 25: the bytes at 200 Mbit/s, at most 70 games a second', () => {
    // 10,000 games of 450 KB: 4.5 GB at 25 MB/s = 180 s, plus the listing.
    expect(storageSeconds(10000, 450_000)).toBeCloseTo(182.2, 1)
    // Small games: the decoder's 70 a second is the limit.
    expect(storageSeconds(1000, 100_000)).toBeCloseTo(2 + 0.02 + 1000 / 70, 1)
    // 25 games: about 2 s to plan and sign, then under half a second.
    expect(storageSeconds(25, 450_000)).toBeCloseTo(2.45, 1)
    // Every Fox game (1.37M, ~406 KB each): about 6 h at 200 Mbit/s.
    expect(storageSeconds(1_372_599, 406_000) / 3600).toBeCloseTo(6.2, 1)
  })

  it('words it: straight from storage, never the Lunar server', () => {
    expect(storageDownloadText(100, 450_000)).toBe(
      'Ready in under a minute, straight from storage.',
    )
    expect(storageDownloadText(10000, 450_000)).toBe(
      'Ready in about 3 min at 200 Mbit/s, straight from storage.',
    )
    expect(storageDownloadText(5, 450_000)).toBe(
      'Ready in under a minute, straight from storage.',
    )
    for (const n of [1, 24, 25, 200, 1000, 100000])
      expect(storageDownloadText(n, 400_000)).not.toMatch(
        /Lunar server|30 a minute|packed|newer/i,
      )
  })

  it('the old after-snapshot arithmetic is gone', () => {
    for (const name of [
      'directDownloadText',
      'directSeconds',
      'directSnapshotSeconds',
      'afterSnapshotAmong',
      'afterSnapshotFilters',
      'afterSnapshotFromFirstPage',
      'isAfterSnapshot',
      'SERVER_GAMES_PER_SEC',
      'PACKED_BYTES_PER_SEC',
      'DIRECT_MAX_GAMES',
    ])
      expect(databaseConstants).not.toHaveProperty(name)
  })
})

describe('what Find replays is told', () => {
  it('the note says up to when games are stored, from the newest zip', () => {
    const info = parseFullDbInfo({
      bundles: [
        {
          fullDb: true,
          bundleSize: 1e12,
          replayCount: 3e6,
          snapshotAt: '2026-06-17T20:06:51.000Z',
          storedThrough: '2026-10-19T03:15:00.000Z',
        },
      ],
    })
    expect(info?.storedThrough).toBe('2026-10-19T03:15:00.000Z')
    expect(storedThroughNote(info)).toBe(
      'Games up to Oct 19, 2026 are available. Newer ones appear after the next update.',
    )
  })

  it('no date (an older database, or no zip): no note', () => {
    const old = parseFullDbInfo({
      bundles: [
        {
          fullDb: true,
          bundleSize: 1e12,
          snapshotAt: '2026-06-17T20:06:51.000Z',
        },
      ],
    })
    expect(old?.storedThrough).toBeNull()
    expect(storedThroughNote(old)).toBeNull()
    expect(storedThroughNote(null)).toBeNull()
    expect(
      storedThroughNote({ storedThrough: 'not a date' as unknown as string }),
    ).toBeNull()
  })

  it('the estimate is the stored games and their bytes', () => {
    expect(
      estimateFromStored({ located: 100, locatedBytes: 40_000_000, other: 0 }),
    ).toEqual({
      replayCount: 100,
      rawSize: 40_000_000,
      estimatedSlpzSize: 40_000_000,
      estimatedZipSize: 40_000_000,
      direct: { located: 100, locatedBytes: 40_000_000, other: 0 },
    })
  })
})

describe('Find replays and Find clips always ask for stored games', () => {
  it('search, estimate, plan and link bodies carry storedOnly', () => {
    expect(databaseSearchBody(defaultDatabaseFilters, 1, 25)).toMatchObject({
      storedOnly: true,
    })
    expect(
      databaseExportFilter({ ...defaultDatabaseFilters, maxFiles: 100 }),
    ).toMatchObject({ storedOnly: true, maxFiles: 100, sort: 'startAt:-1' })
    expect(
      databaseExportFilter({
        ...defaultDatabaseFilters,
        sort: 'replayOldest',
        p1Characters: ['2'],
      }),
    ).toMatchObject({ storedOnly: true, p1CharacterId: '2', sort: 'startAt:1' })
  })

  it("Find clips' search carries it; a search saved for a home-recorded run doesn't", () => {
    const f = {
      type: 'combo',
      attackerCharacterId: [],
      victimCharacterId: [],
      attackerConnectCode: '',
      victimConnectCode: '',
      tournaments: [],
      stageId: [],
      minDamage: 0,
      killOnly: false,
      zeroToDeath: false,
      includeInfinites: false,
      includeCpu: false,
      sort: 'newest',
    } as unknown as Parameters<typeof findClipsBody>[0]
    expect(findClipsBody(f, 1)).toMatchObject({
      storedOnly: true,
      type: 'combo',
    })
    expect(clipSearchBody(f, 1)).not.toHaveProperty('storedOnly')
  })
})
