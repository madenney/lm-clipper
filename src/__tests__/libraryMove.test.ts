/**
 * @jest-environment node
 *
 * Moving the Replay Library (launch review DL-1, WIN-2, DATA-2, DL-2): a failing
 * `rm` of the old folder after a verified cross-drive copy must never take the
 * new copy with it, and every path a transfer keeps in the library follows the
 * move, so the next start still reads the history.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

jest.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '3.0.0' },
  shell: {},
}))
jest.mock('../main/askRenderer', () => ({ askDialog: jest.fn() }))
jest.mock('../main/dbAsync', () => ({ libraryCall: jest.fn() }))
jest.mock('../main/controller/missingReplays', () => ({
  startMissingCheck: jest.fn(),
}))
jest.mock('../main/controller/compaction', () => ({
  runCompactWorker: jest.fn(),
}))
jest.mock('../main/controller/filters', () => ({ buildFilterJSON: jest.fn() }))

// eslint-disable-next-line import/first
import { moveLibraryItems, treeStats } from '../main/controller/libraryTools'
// eslint-disable-next-line import/first
import { relocateJobs } from '../main/managers/TransferManager'
// eslint-disable-next-line import/first
import {
  loadSavedTransfers,
  writeSavedTransfers,
} from '../main/transfers/persistence'
// eslint-disable-next-line import/first
import type { SavedTransfer } from '../main/transfers/savedTransfer'

let root: string
let oldFolder: string
let newFolder: string

const items = () =>
  ['library.sqlite', 'replays', 'Downloads'].map((name) => ({
    name,
    from: path.join(oldFolder, name),
    to: path.join(newFolder, name),
  }))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-move-'))
  oldFolder = path.join(root, 'old')
  newFolder = path.join(root, 'new')
  fs.mkdirSync(path.join(oldFolder, 'replays', 'ab'), { recursive: true })
  fs.mkdirSync(path.join(oldFolder, 'Downloads'), { recursive: true })
  fs.mkdirSync(newFolder)
  fs.writeFileSync(path.join(oldFolder, 'library.sqlite'), 'index')
  fs.writeFileSync(path.join(oldFolder, 'replays', 'ab', 'one.slpz'), 'game1')
  fs.writeFileSync(path.join(oldFolder, 'replays', 'two.slpz'), 'game22')
})

afterEach(() => {
  jest.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('moveLibraryItems across drives', () => {
  it('copies, verifies, commits, then removes the old items', async () => {
    const commit = jest.fn()
    const { leftovers } = await moveLibraryItems(items(), false, commit)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(leftovers).toEqual([])
    expect(fs.existsSync(path.join(oldFolder, 'replays'))).toBe(false)
    expect(
      fs.readFileSync(
        path.join(newFolder, 'replays', 'ab', 'one.slpz'),
        'utf8',
      ),
    ).toBe('game1')
    expect(
      fs.readFileSync(path.join(newFolder, 'library.sqlite'), 'utf8'),
    ).toBe('index')
  })

  it('a failing rm of the old replays keeps the new copy and reports the leftover', async () => {
    const realRm = fs.promises.rm
    jest.spyOn(fs.promises, 'rm').mockImplementation(async (p, opts) => {
      if (String(p) === path.join(oldFolder, 'replays'))
        throw Object.assign(new Error('locked by antivirus'), { code: 'EBUSY' })
      return realRm(p, opts)
    })
    const commit = jest.fn()
    const { leftovers } = await moveLibraryItems(items(), false, commit)
    expect(commit).toHaveBeenCalled()
    expect(leftovers).toEqual([path.join(oldFolder, 'replays')])
    // The new copy is whole; the old library.sqlite went, the locked folder stayed.
    expect(fs.existsSync(path.join(newFolder, 'library.sqlite'))).toBe(true)
    expect(
      fs.existsSync(path.join(newFolder, 'replays', 'ab', 'one.slpz')),
    ).toBe(true)
    expect(fs.existsSync(path.join(newFolder, 'replays', 'two.slpz'))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(oldFolder, 'replays', 'two.slpz'))).toBe(
      true,
    )
  })

  it('a copy that does not match is removed and the old library is untouched', async () => {
    const realCp = fs.promises.cp
    jest.spyOn(fs.promises, 'cp').mockImplementation(async (from, to, opts) => {
      await realCp(from, to, opts)
      // Lose a file in the copy.
      if (String(to).endsWith('replays'))
        fs.rmSync(path.join(String(to), 'two.slpz'))
    })
    const commit = jest.fn()
    await expect(moveLibraryItems(items(), false, commit)).rejects.toThrow(
      /does not match/,
    )
    expect(commit).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(newFolder, 'replays'))).toBe(false)
    expect(fs.existsSync(path.join(newFolder, 'library.sqlite'))).toBe(false)
    expect(fs.existsSync(path.join(oldFolder, 'replays', 'two.slpz'))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(oldFolder, 'library.sqlite'))).toBe(true)
  })

  it('a failing commit drops the copies and keeps the old library', async () => {
    await expect(
      moveLibraryItems(items(), false, () => {
        throw new Error('index would not open')
      }),
    ).rejects.toThrow(/index/)
    expect(fs.existsSync(path.join(newFolder, 'replays'))).toBe(false)
    expect(fs.existsSync(path.join(oldFolder, 'replays', 'two.slpz'))).toBe(
      true,
    )
  })

  it('a copy that fails half way removes only what it made', async () => {
    fs.writeFileSync(path.join(root, 'precious.txt'), 'mine')
    const realCp = fs.promises.cp
    let calls = 0
    jest.spyOn(fs.promises, 'cp').mockImplementation(async (from, to, opts) => {
      if (++calls === 2) throw new Error('disk gone')
      return realCp(from, to, opts)
    })
    await expect(moveLibraryItems(items(), false, jest.fn())).rejects.toThrow(
      /disk gone/,
    )
    expect(fs.existsSync(path.join(newFolder, 'library.sqlite'))).toBe(false)
    expect(fs.existsSync(path.join(oldFolder, 'library.sqlite'))).toBe(true)
    expect(fs.readFileSync(path.join(root, 'precious.txt'), 'utf8')).toBe(
      'mine',
    )
  })
})

describe('moveLibraryItems on one drive', () => {
  it('renames, and puts everything back when the commit fails', async () => {
    await expect(
      moveLibraryItems(items(), true, () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(fs.existsSync(path.join(oldFolder, 'library.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(oldFolder, 'replays', 'two.slpz'))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(newFolder, 'replays'))).toBe(false)
  })

  it('moves the items', async () => {
    await moveLibraryItems(items(), true, jest.fn())
    expect(fs.existsSync(path.join(newFolder, 'replays', 'two.slpz'))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(oldFolder, 'replays'))).toBe(false)
  })
})

it('treeStats counts entries and bytes', async () => {
  const a = await treeStats(path.join(oldFolder, 'replays'))
  expect(a).toEqual({ entries: 4, bytes: 'game1'.length + 'game22'.length })
})

describe('relocating transfers', () => {
  const job = (over: Partial<SavedTransfer> = {}): SavedTransfer => {
    const outputDir = path.join(oldFolder, 'Downloads', 'Lunar-2026-11-10-aaaa')
    return {
      id: '11111111-2222-3333-4444-555555555555',
      kind: 'database',
      title: 'Add 50 clips',
      createdAt: 1,
      stage: 'completed',
      detail: 'done',
      outputDir,
      current: 0,
      total: null,
      clipsFile: path.join(outputDir, 'clips.json'),
      gamesFile: path.join(outputDir, 'games.json'),
      directFiles: path.join(outputDir, 'direct', 'files.json'),
      preparedPath: path.join(outputDir, 'replays.json'),
      ...over,
    } as SavedTransfer
  }

  it('moves every path under the old library, so the next start still loads the history', () => {
    const jobs = [job()]
    expect(relocateJobs(jobs, oldFolder, newFolder)).toBe(true)
    const j = jobs[0]
    for (const p of [
      j.outputDir,
      j.clipsFile!,
      j.gamesFile!,
      j.directFiles!,
      j.preparedPath!,
    ])
      expect(p.startsWith(`${newFolder}${path.sep}`)).toBe(true)
    // Round trip through the file: parseSavedTransfer checks each path lies in outputDir.
    const state = path.join(root, 'transfers.json')
    writeSavedTransfers(state, jobs)
    const loaded = loadSavedTransfers(state)!
    expect(loaded).toHaveLength(1)
    expect(loaded[0].clipsFile).toBe(j.clipsFile)
  })

  it('without the fix the history would be refused: the old paths are skipped, the rest load', () => {
    const state = path.join(root, 'transfers.json')
    const stale = job() // paths in the old folder
    const moved = job({ id: '99999999-2222-3333-4444-555555555555' })
    relocateJobs([moved], oldFolder, newFolder)
    // A record whose clipsFile no longer lies in its outputDir is invalid.
    const broken = {
      ...stale,
      id: '88888888-2222-3333-4444-555555555555',
      clipsFile: path.join(newFolder, 'elsewhere', 'clips.json'),
    }
    fs.writeFileSync(
      state,
      JSON.stringify({ version: 1, jobs: [broken, moved, stale] }),
    )
    const loaded = loadSavedTransfers(state)!
    expect(loaded.map((j) => j.id)).toEqual([moved.id, stale.id])
    // The bad record is kept aside, not deleted.
    expect(fs.existsSync(`${state}.bad`)).toBe(true)
    expect(
      JSON.parse(fs.readFileSync(`${state}.bad`, 'utf8')).jobs,
    ).toHaveLength(1)
  })

  it('falls back to the backup when the file was cut off mid-write', () => {
    const state = path.join(root, 'transfers.json')
    writeSavedTransfers(state, [job()])
    // The second write copies the first to .bak (rate limited to once a minute,
    // so make the backup by hand as a crash would have left it).
    fs.copyFileSync(state, `${state}.bak`)
    fs.writeFileSync(state, '{"version":1,"jobs":[{"id"')
    const loaded = loadSavedTransfers(state)!
    expect(loaded).toHaveLength(1)
  })

  it('does not refuse a newer file version', () => {
    const state = path.join(root, 'transfers.json')
    fs.writeFileSync(
      state,
      JSON.stringify({ version: 2, jobs: [job(), { future: true }] }),
    )
    expect(loadSavedTransfers(state)).toHaveLength(1)
  })
})
