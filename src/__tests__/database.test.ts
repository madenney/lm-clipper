/** @jest-environment node */
import {
  databaseExportFilter,
  defaultDatabaseFilters,
  validateDatabaseFilters,
} from '../constants/database'
import { downloadRange, storageUrlAllowed } from '../main/databaseClient'

describe('database selection contract', () => {
  it('keeps matchup, source, date, limit, and ordering on the export', () => {
    expect(
      databaseExportFilter({
        ...defaultDatabaseFilters,
        p1Characters: ['2'],
        p2Codes: ['TEST#123'],
        stageFilters: ['31'],
        sources: ['ranked'],
        startDate: '2025-01-01',
        sort: 'replayOldest',
        maxFiles: 200,
      }),
    ).toEqual({
      maxFiles: 200,
      sort: 'startAt:1',
      // Find replays: only games stored on storage (every download comes from R2).
      storedOnly: true,
      p1CharacterId: '2',
      p2ConnectCode: 'TEST#123',
      stageId: '31',
      source: 'ranked',
      startDate: '2025-01-01',
    })
  })
  it('does not accidentally request the entire database', () => {
    expect(
      databaseExportFilter({ ...defaultDatabaseFilters, maxFiles: 250000 })
        .maxFiles,
    ).toBe(250000)
    // Any positive whole number is fine (no upper limit); it must still be given.
    for (const maxFiles of [0, -1, NaN, 2.5, Infinity])
      expect(() =>
        databaseExportFilter({ ...defaultDatabaseFilters, maxFiles }),
      ).toThrow()
    expect(() =>
      validateDatabaseFilters({ ...defaultDatabaseFilters, sources: [] }),
    ).toThrow()
    expect(() =>
      validateDatabaseFilters({
        ...defaultDatabaseFilters,
        startDate: '2025-02-01',
        endDate: '2025-01-01',
      }),
    ).toThrow()
  })
})

describe('download validation', () => {
  it('accepts storage HTTPS but rejects arbitrary hosts and credentials', () => {
    expect(storageUrlAllowed('https://dl.lunarmelee.com/a.zip')).toBe(true)
    expect(
      storageUrlAllowed(
        'https://c5d885cd0ec052db32b77769107a0b67.r2.cloudflarestorage.com/lm-replays/jobs/a.zip',
      ),
    ).toBe(true)
    for (const url of [
      'https://someone-else.r2.cloudflarestorage.com/a.zip',
      'http://dl.lunarmelee.com/a',
      'https://dl.lunarmelee.com.evil.test/a',
      'https://user:pass@dl.lunarmelee.com/a',
      'https://localhost/a',
      'file:///tmp/a',
      'https://dl.lunarmelee.com:444/a',
    ])
      expect(storageUrlAllowed(url)).toBe(false)
  })
  it('continues only the same object at precisely the saved offset', () => {
    expect(
      downloadRange(
        { status: 206, range: 'bytes 10-19/20', etag: 'same' },
        10,
        'same',
      ),
    ).toEqual({ append: true, total: 20 })
    expect(() =>
      downloadRange(
        { status: 206, range: 'bytes 0-19/20', etag: 'same' },
        10,
        'same',
      ),
    ).toThrow()
    expect(() =>
      downloadRange(
        { status: 206, range: 'bytes 10-19/20', etag: 'new' },
        10,
        'same',
      ),
    ).toThrow()
    expect(() => downloadRange({ status: 416 }, 20, 'same')).toThrow()
  })
  it('restarts when the server ignores the range instead of appending', () => {
    expect(downloadRange({ status: 200, length: '20' }, 10, 'old')).toEqual({
      append: false,
      total: 20,
    })
  })
})

describe('player suggestions', () => {
  it('keeps well-formed players (max 10) and drops the rest', () => {
    const { parsePlayerSuggestions, parseDatabaseRequest } =
      // eslint-disable-next-line global-require
      require('../constants/database')
    const players = parsePlayerSuggestions([
      {
        connectCode: 'MANG#0',
        displayName: 'mang',
        gameCount: 49911,
        aliases: ['Mango', 5], // a server still sending these: dropped
      },
      { connectCode: 7, gameCount: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({
        connectCode: `X#${i}`,
        displayName: null,
        gameCount: i,
      })),
    ])
    expect(players).toHaveLength(10)
    expect(players[0]).toEqual({
      connectCode: 'MANG#0',
      displayName: 'mang',
      gameCount: 49911,
    })
    expect(parsePlayerSuggestions({ not: 'a list' })).toEqual([])
    expect(
      parseDatabaseRequest({
        action: 'autocomplete',
        q: '  mang ',
        tournaments: true,
      }),
    ).toEqual({ action: 'autocomplete', q: 'mang', tournaments: true })
  })
})

describe('tournaments in the search box', () => {
  const db = require('../constants/database') // eslint-disable-line global-require

  it('keeps well-formed tournament suggestions', () => {
    const out = db.parseTournamentSuggestions({
      tournaments: [
        {
          _id: 'kotj-7',
          name: 'KOTJ #7',
          games: 195,
          firstAt: '2026-09-21T00:00:00Z',
          lastAt: null,
          extra: 1,
        },
        { _id: '../x', name: 'bad', games: 1 },
      ],
    })
    expect(out).toEqual([
      {
        _id: 'kotj-7',
        name: 'KOTJ #7',
        games: 195,
        firstAt: '2026-09-21T00:00:00Z',
        lastAt: null,
      },
    ])
    expect(db.parseTournamentSuggestions(null)).toEqual([])
  })

  it('filters downloads by tournament and accepts older saved filters', () => {
    const body = db.databaseExportFilter({
      ...db.defaultDatabaseFilters,
      tournaments: ['kotj-7', 'kotj-8'],
    })
    expect(body.tournament).toBe('kotj-7,kotj-8')
    const { tournaments: _t, ...old } = db.defaultDatabaseFilters
    expect(db.validateDatabaseFilters(old).tournaments).toEqual([])
    expect(() =>
      db.validateDatabaseFilters({
        ...db.defaultDatabaseFilters,
        tournaments: ['Bad Key'],
      }),
    ).toThrow()
  })
})
