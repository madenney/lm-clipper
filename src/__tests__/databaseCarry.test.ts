import { defaultDatabaseFilters } from '../constants/database'
import { defaultClipSearch } from '../constants/clipSearch'
import {
  clipsToGames,
  gamesToClips,
  picksFor,
} from '../renderer/lib/databaseCarry'

describe('carrying a search between Pre-parsed moments and Download games', () => {
  it('games → moments keeps players, characters and tournaments, never CPU or infinites', () => {
    const games = {
      ...defaultDatabaseFilters,
      p1Codes: ['MANG#0', 'ZAIN#0'],
      p1Characters: ['2', '1'],
      p2Codes: ['XX#02'],
      p2Characters: ['9'],
      tournaments: ['kotj-7'],
      includeCpu: true,
      stageFilters: ['31'],
    }
    const clips = gamesToClips(games, { ...defaultClipSearch, killOnly: true })
    expect(clips).toMatchObject({
      attackerConnectCode: 'MANG#0,ZAIN#0',
      attackerCharacterId: ['2'],
      victimConnectCode: 'XX#02',
      victimCharacterId: ['9'],
      tournaments: ['kotj-7'],
      includeCpu: false,
      includeInfinites: false,
      killOnly: true,
    })
  })

  it('moments → games keeps the games form’s stage, dates and sources', () => {
    const clips = {
      ...defaultClipSearch,
      attackerConnectCode: 'MANG#0',
      attackerCharacterId: ['2'],
      victimConnectCode: '',
    }
    const games = clipsToGames(clips, {
      ...defaultDatabaseFilters,
      stageFilters: ['31'],
      startDate: '2024-01-01',
      sources: ['tournament'],
    })
    expect(games).toMatchObject({
      p1Codes: ['MANG#0'],
      p1Characters: ['2'],
      p2Codes: [],
      stageFilters: ['31'],
      startDate: '2024-01-01',
      sources: ['tournament'],
    })
  })

  it('keeps only the tournament chips whose keys carried', () => {
    const picks = [
      { key: 'a', name: 'A' },
      { key: 'b', name: 'B' },
    ]
    expect(picksFor(['b'], picks)).toEqual([{ key: 'b', name: 'B' }])
  })
})
