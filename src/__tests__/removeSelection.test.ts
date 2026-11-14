/**
 * @jest-environment node
 *
 * Removing a tray selection in main (ClipManager): a short list of ids works as
 * before; a selection (Select All, a big range) is resolved by the DB worker and
 * removed in statements of at most 5,000 ids. A filter step's rows go with what
 * later steps made from them; the Replays step's games go from the project, the
 * replay library and My Replays (never from disk). The worker is mocked: this
 * checks what main asks it, not SQLite (selectionSql.test.ts, removeCascade.test.ts
 * and scripts/worker-check/remove.js cover that).
 */
import { Selection } from '../lib/selection'

const mockCalls: { fn: string; args: unknown[] }[] = []
const mockAllIds = new Uint32Array(12345).map((_, i) => i + 1)
jest.mock('../main/dbAsync', () => {
  const log =
    (fn: string, out: (..._a: any[]) => unknown = () => null) =>
    async (...args: unknown[]) => {
      mockCalls.push({ fn, args })
      return out(...args)
    }
  return {
    getMetaData: log('getMetaData', () => ({})),
    deleteRowsByFilePathsAsync: log('deleteRowsByFilePaths'),
    deleteFilesAsync: log('deleteFiles'),
    getFilePathsByIdsAsync: log('getFilePathsByIds', (_p, ids: number[]) =>
      ids.map((id) => `/r/${id}.slp`),
    ),
    deleteRowsAsync: log('deleteRows'),
    updateSortOrderAsync: log('updateSortOrder'),
    selectionIdsAsync: log('selectionIds', () => mockAllIds),
    getGameFilterRowInfo: log('getGameFilterRowInfo', (_p, _t, ids: number[]) =>
      ids.map((id) => ({ fileId: id, filePath: `/r/${id}.slp` })),
    ),
    removeGamesAsync: log('removeGames', (_p, ids: number[]) =>
      ids.map((id) => `/r/${id}.slp`),
    ),
    removeResultsCascadeAsync: log(
      'removeResultsCascade',
      (_p, tableId: string, ids: number[]) => ({ [tableId]: ids.length }),
    ),
    removeGamesFromProjectFileAsync: log('removeGamesFromProjectFile', () => 0),
    libraryCall: log('library', () => 0),
  }
})
jest.mock('../main/overviewCache', () => ({
  invalidateOverview: async () => {},
  invalidateProjectOverviews: async () => {},
}))
jest.mock('../main/dbConnection', () => ({
  getDb: () => null,
  setOnCloseCallback: () => {},
}))
jest.mock('../models/Archive', () => ({
  __esModule: true,
  default: class {
    filters = []
  },
}))
jest.mock('../main/ipcUtils', () => ({
  unpackRequest: (d: { requestId: string; payload: unknown }) => d,
  reply: (_e: unknown, _c: string, _id: string, out: unknown) => out,
  buildShallowArchive: () => ({}),
}))

// eslint-disable-next-line import/first
import ClipManager from '../main/managers/ClipManager'

const archive = {
  path: '/p.lunar',
  filters: [
    { id: 'files', type: 'files' },
    { id: 'f1', type: 'comboFilter' },
    { id: 'f2', type: 'comboFilter' },
  ],
}
// An existing file stands in for My Replays (it must exist to be updated).
const MY_REPLAYS = __filename
const manager = () =>
  new ClipManager({ webContents: { send: () => {} } } as never, {
    getArchive: () => archive as never,
    setArchive: () => {},
    getLibraryFolder: () => '/Library',
    getMyReplaysPath: () => MY_REPLAYS,
  })
const deleted = () =>
  mockCalls
    .filter((c) => c.fn === 'deleteRows')
    .map((c) => c.args[2] as number[])
const calls = (fn: string) => mockCalls.filter((c) => c.fn === fn)

beforeEach(() => {
  mockCalls.length = 0
})

describe('ClipManager removals', () => {
  it('a list of ids removes those results and what later steps made from them', async () => {
    const out = await manager().removeResult(
      null as never,
      {
        requestId: '1',
        payload: { filterId: 'f1', rowIds: [3, 1, 2] },
      } as never,
    )
    expect(out).toEqual({ removed: 3 })
    expect(calls('removeResultsCascade').map((c) => c.args)).toEqual([
      ['/p.lunar', 'f1', [3, 1, 2], [{ id: 'f2', type: 'comboFilter' }]],
    ])
    expect(mockCalls.some((c) => c.fn === 'selectionIds')).toBe(false)
    // A filter step never touches games or the library.
    for (const fn of ['removeGames', 'library', 'removeGamesFromProjectFile'])
      expect(calls(fn)).toHaveLength(0)
  })

  it('Select All on a filter step is resolved by the worker', async () => {
    const wire = Selection.everything(12345).toWire()
    const out = await manager().removeResult(
      null as never,
      {
        requestId: '1',
        payload: { filterId: 'f2', selection: wire },
      } as never,
    )
    expect(out).toEqual({ removed: 12345 })
    const asked = calls('selectionIds')
    expect(asked).toHaveLength(1)
    expect(asked[0].args.slice(0, 2)).toEqual(['/p.lunar', 'f2'])
    const [cascade] = calls('removeResultsCascade')
    expect(cascade.args[2]).toEqual(Array.from(mockAllIds))
    // The last step: nothing after it.
    expect(cascade.args[3]).toEqual([])
  })

  it('the Replays step: its games go from the project, the library and My Replays, in batches', async () => {
    const ids = Array.from({ length: 7000 }, (_, i) => i * 2 + 1)
    const out = await manager().removeResult(
      null as never,
      {
        requestId: '1',
        payload: { filterId: 'files', selection: Selection.of(ids).toWire() },
      } as never,
    )
    expect(out).toEqual({ removed: 7000 })
    expect(mockCalls.some((c) => c.fn === 'selectionIds')).toBe(false)
    expect(
      calls('getGameFilterRowInfo').map((c) => (c.args[2] as number[]).length),
    ).toEqual([5000, 2000])
    // Games (with every step's rows made from them), batch by batch.
    const games = calls('removeGames')
    expect(games.map((c) => (c.args[1] as number[]).length)).toEqual([
      5000, 2000,
    ])
    expect(games[0].args[2]).toEqual(['files', 'f1', 'f2'])
    // The library and My Replays forget the same paths.
    const forget = calls('library')
    expect(forget.map((c) => c.args.slice(0, 2))).toEqual([
      ['libraryForget', '/Library'],
      ['libraryForget', '/Library'],
    ])
    expect((forget[1].args[2] as string[]).length).toBe(2000)
    const my = calls('removeGamesFromProjectFile')
    expect(my.map((c) => c.args[0])).toEqual([MY_REPLAYS, MY_REPLAYS])
    expect(deleted().flat()).toEqual(ids)
  })

  it('removing games by selection resolves the files table', async () => {
    const out = await manager().removeGame(
      null as never,
      {
        requestId: '1',
        payload: { selection: Selection.everything(12345).toWire() },
      } as never,
    )
    expect(out).toEqual({ removed: 12345 })
    const asked = mockCalls.find((c) => c.fn === 'selectionIds')!
    expect(asked.args[1]).toBe('files')
    expect(
      calls('removeGames').map((c) => (c.args[1] as number[]).length),
    ).toEqual([5000, 5000, 2345])
    expect(calls('library')).toHaveLength(3)
    expect(calls('removeGamesFromProjectFile')).toHaveLength(3)
  })

  it('My Replays itself open: it is not updated a second time', async () => {
    const m = new ClipManager({ webContents: { send: () => {} } } as never, {
      getArchive: () => archive as never,
      setArchive: () => {},
      getLibraryFolder: () => '/Library',
      getMyReplaysPath: () => '/p.lunar',
    })
    await m.removeGame(
      null as never,
      { requestId: '1', payload: { fileIds: [1, 2] } } as never,
    )
    expect(calls('removeGames')).toHaveLength(1)
    expect(calls('library')).toHaveLength(1)
    expect(calls('removeGamesFromProjectFile')).toHaveLength(0)
  })

  it('removing missing replays changes only the project', async () => {
    await manager().removeGames([1, 2, 3])
    expect(calls('removeGames')).toHaveLength(1)
    expect(calls('library')).toHaveLength(0)
    expect(calls('removeGamesFromProjectFile')).toHaveLength(0)
  })

  it('counts the replays a Replays-tray removal would delete', async () => {
    const m = manager()
    const all = await m.previewRemoveGames(
      null as never,
      {
        requestId: '1',
        payload: {
          filterId: 'files',
          selection: Selection.everything(12345).toWire(),
        },
      } as never,
    )
    expect(all).toEqual({ games: 12345 })
    const some = await m.previewRemoveGames(
      null as never,
      { requestId: '1', payload: { filterId: 'files', ids: [4, 5] } } as never,
    )
    expect(some).toEqual({ games: 2 })
    // Counting removes nothing.
    for (const fn of ['removeGames', 'deleteRows', 'library'])
      expect(calls(fn)).toHaveLength(0)
  })

  it('refuses a request that names nothing', async () => {
    const out = await manager().removeResult(
      null as never,
      {
        requestId: '1',
        payload: { filterId: 'f1' },
      } as never,
    )
    expect(out).toEqual({ error: 'invalid request' })
  })
})
