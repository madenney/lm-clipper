import { describeSearch } from '../renderer/components/DatabasePanel'
import { defaultDatabaseFilters } from '../constants/database'

jest.mock('../renderer/ipcBridge', () => ({ __esModule: true, default: {} }))

describe('describeSearch', () => {
  it('says the picked player plays the Player character', () => {
    expect(
      describeSearch(
        { ...defaultDatabaseFilters, p1Codes: ['XX#02'], p1Characters: ['19'] },
        [],
      ),
    ).toBe('XX#02 as Sheik vs anyone')
  })

  it('reads the whole search', () => {
    expect(
      describeSearch(
        {
          ...defaultDatabaseFilters,
          p1Characters: ['2'],
          p2Characters: ['9'],
          stageFilters: ['31'],
          sources: ['tournament'],
        },
        [{ key: 'kotj-7', name: 'KOTJ #7' }],
      ),
    ).toBe(
      'Anyone as Fox vs anyone as Marth · Battlefield · KOTJ #7 · Tournaments',
    )
    expect(describeSearch(defaultDatabaseFilters, [])).toBe('Anyone vs anyone')
  })

  it('names ranked games as anonymous', () => {
    expect(
      describeSearch({ ...defaultDatabaseFilters, sources: ['ranked'] }, []),
    ).toContain('Ranked (anonymous)')
  })
})
