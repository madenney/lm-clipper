import { parseReplayInfo } from '../constants/replayInfo'
import { parseDatabaseRequest } from '../constants/database'

const ID = '6abd2df68fe2062a80e9c4e6'

describe('parseReplayInfo', () => {
  const replay = {
    _id: ID,
    source: 'tournament',
    startAt: '2026-09-29T01:40:38.696Z',
    tournamentName: 'KOTJ #8',
    setGame: 5,
    viewCount: 227,
    winner: 1,
    players: [
      {
        playerIndex: 0,
        displayName: 'Goober',
        connectCode: 'BLUE#748',
        characterId: 15,
      },
      {
        playerIndex: 1,
        tag: 'Ninth',
        connectCode: 'NINE#772',
        characterId: 22,
      },
    ],
  }
  const stats = {
    summary: {
      players: [
        {
          playerIndex: 0,
          startStocks: 4,
          stocksLost: 4,
          kills: 3,
          openings: 12,
          successfulConversions: 7,
          damageDealt: 267.83,
          neutralWins: 8,
          counterHits: 4,
          inputsPerMinute: 719.9,
          actions: {
            wavedashCount: 5,
            wavelandCount: 14,
            dashDanceCount: 4,
            lCancelCount: { success: 24, fail: 3 },
          },
        },
        {
          playerIndex: 1,
          startStocks: 4,
          stocksLost: 3,
          kills: 4,
          openings: 10,
        },
      ],
    },
  }

  it('keeps the context and both players’ stats', () => {
    const info = parseReplayInfo(ID, replay, stats)!
    expect(info).toMatchObject({
      tournamentName: 'KOTJ #8',
      setGame: 5,
      source: 'tournament',
      viewCount: 227,
      winner: 1,
      hasStats: true,
    })
    expect(info.players[0]).toMatchObject({
      name: 'Goober',
      stocksLeft: 0,
      kills: 3,
      lCancel: { success: 24, fail: 3 },
      wavedashes: 5,
    })
    expect(info.players[1]).toMatchObject({
      name: 'Ninth',
      stocksLeft: 1,
      kills: 4,
      lCancel: null,
    })
  })

  it('works without stats, and refuses a record for another replay', () => {
    expect(parseReplayInfo(ID, replay, null)!.hasStats).toBe(false)
    expect(
      parseReplayInfo(ID, { ...replay, _id: 'a'.repeat(24) }, stats),
    ).toBeNull()
    expect(parseReplayInfo(ID, null, stats)).toBeNull()
  })
})

describe('replayInfo request', () => {
  it('takes a replay id or a .slp path', () => {
    expect(
      parseDatabaseRequest({ action: 'replayInfo', replayId: ID }),
    ).toEqual({ action: 'replayInfo', replayId: ID, path: undefined })
    expect(
      parseDatabaseRequest({ action: 'replayInfo', path: '/x/Game.slp' }),
    ).toMatchObject({ path: '/x/Game.slp' })
    expect(() =>
      parseDatabaseRequest({ action: 'replayInfo', replayId: 'nope' }),
    ).toThrow()
    expect(() =>
      parseDatabaseRequest({ action: 'replayInfo', path: '/etc/passwd' }),
    ).toThrow()
    expect(() => parseDatabaseRequest({ action: 'replayInfo' })).toThrow()
  })
})
