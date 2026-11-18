import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  ABANDONED_MS,
  SlippiAutoImport,
  findNewReplays,
  isFinishedSlp,
  newScanState,
  nextSince,
} from '../main/slippiAutoImport'

const HEADER = Buffer.from('{U\x03raw[$U#l', 'latin1')

/** A .slp: `rawLength` 0 is a game still being played (Slippi fills it in at the end). */
function slp(file: string, rawLength: number, mtimeMs: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const len = Buffer.alloc(4)
  len.writeInt32BE(rawLength)
  fs.writeFileSync(file, Buffer.concat([HEADER, len, Buffer.alloc(64)]))
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return file
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slippi-auto-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const T = Date.parse('2026-11-17T12:00:00Z')

describe('isFinishedSlp', () => {
  it('is true once the data length is filled in, false while it is 0 or the file is not a .slp', () => {
    expect(isFinishedSlp(slp(path.join(dir, 'a.slp'), 1234, T))).toBe(true)
    expect(isFinishedSlp(slp(path.join(dir, 'b.slp'), 0, T))).toBe(false)
    fs.writeFileSync(path.join(dir, 'c.slp'), 'not a replay at all')
    expect(isFinishedSlp(path.join(dir, 'c.slp'))).toBe(false)
    fs.writeFileSync(path.join(dir, 'd.slp'), '{U')
    expect(isFinishedSlp(path.join(dir, 'd.slp'))).toBe(false)
    expect(isFinishedSlp(path.join(dir, 'missing.slp'))).toBe(false)
  })
})

describe('findNewReplays', () => {
  it('takes finished games newer than since, in the folder and its monthly folders, once', () => {
    const since = T - 60_000
    slp(path.join(dir, 'Game_old.slp'), 100, since - 5000)
    const a = slp(path.join(dir, 'Game_a.slp'), 100, T - 30_000)
    const b = slp(path.join(dir, '2026-11', 'Game_b.slp'), 100, T - 20_000)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    const state = newScanState()
    const first = findNewReplays(dir, since, state, T)
    expect(first.ready.map((r) => r.file)).toEqual([a, b])
    expect(first.waitingSince).toBeNull()
    expect(findNewReplays(dir, since, state, T).ready).toEqual([])
  })

  it('leaves a game being played (length 0) or just written for later, and says how old it is', () => {
    const since = T - 60_000
    const playing = slp(path.join(dir, 'Game_live.slp'), 0, T - 10_000)
    const justNow = slp(path.join(dir, 'Game_now.slp'), 100, T - 500)
    const state = newScanState()
    const r = findNewReplays(dir, since, state, T)
    expect(r.ready).toEqual([])
    expect(r.waitingSince).toBe(T - 10_000)
    // The game ends: Slippi fills in the length.
    slp(playing, 500, T + 1000)
    const later = findNewReplays(dir, since, state, T + 5000)
    expect(later.ready.map((x) => x.file).sort()).toEqual(
      [justNow, playing].sort(),
    )
  })

  it('takes a game left unfinished for a long time (a crash) instead of waiting forever', () => {
    const since = T - 2 * ABANDONED_MS
    const crashed = slp(
      path.join(dir, 'Game_crash.slp'),
      0,
      T - ABANDONED_MS - 1000,
    )
    expect(
      findNewReplays(dir, since, newScanState(), T).ready.map((r) => r.file),
    ).toEqual([crashed])
  })

  it('does not open a monthly folder nothing was added to since `since`', () => {
    const old = slp(path.join(dir, '2026-10', 'Game_x.slp'), 100, T - 100_000)
    fs.utimesSync(path.dirname(old), (T - 100_000) / 1000, (T - 100_000) / 1000)
    expect(findNewReplays(dir, T - 50_000, newScanState(), T).ready).toEqual([])
  })

  it('answers nothing for a folder that is not there', () => {
    expect(
      findNewReplays(path.join(dir, 'nope'), 0, newScanState(), T),
    ).toEqual({ ready: [], waitingSince: null })
  })
})

describe('nextSince', () => {
  it('moves past what was taken but never past a game still being played', () => {
    expect(nextSince(10, [{ mtimeMs: 50 }, { mtimeMs: 40 }], null)).toBe(50)
    expect(nextSince(10, [{ mtimeMs: 50 }], 30)).toBe(29)
    expect(nextSince(10, [], 5)).toBe(10)
  })
})

describe('SlippiAutoImport', () => {
  const host = (
    over: Partial<{ project: string | null; slippi: string | null }> = {},
  ) => {
    const config: {
      autoImportSlippi?: boolean
      autoImportSlippiSince?: number | null
    } = {}
    const imported: string[][] = []
    const saves = { n: 0 }
    const h = {
      getConfig: () => config,
      saveConfig: () => {
        saves.n++
      },
      projectPath: () => ('project' in over ? over.project! : '/p/one'),
      slippiDir: () => ('slippi' in over ? over.slippi! : dir),
      importFiles: (files: string[]) => imported.push(files),
      log: () => {},
    }
    return { h, config, imported, saves }
  }

  it('does nothing while off, and forgets its mark when turned off', () => {
    const { h, config, imported } = host()
    const auto = new SlippiAutoImport(h)
    slp(path.join(dir, 'Game_a.slp'), 100, T - 1000 * 30)
    expect(auto.tick(T)).toEqual([])
    config.autoImportSlippiSince = T - 99_999
    auto.tick(T)
    expect(config.autoImportSlippiSince).toBeNull()
    expect(imported).toEqual([])
  })

  it('turned on: starts from now (not the back catalogue), then imports each new finished game once', () => {
    const { h, config, imported } = host()
    const auto = new SlippiAutoImport(h)
    slp(path.join(dir, 'Game_old.slp'), 100, T - 60_000)
    config.autoImportSlippi = true
    expect(auto.tick(T)).toEqual([])
    expect(config.autoImportSlippiSince).toBe(T)
    const g = slp(path.join(dir, '2026-11', 'Game_new.slp'), 100, T + 10_000)
    fs.utimesSync(path.dirname(g), (T + 10_000) / 1000, (T + 10_000) / 1000)
    expect(auto.tick(T + 20_000)).toEqual([g])
    expect(imported).toEqual([[g]])
    expect(config.autoImportSlippiSince).toBe(T + 10_000)
    expect(auto.tick(T + 25_000)).toEqual([])
  })

  it('imports nothing with no project open or no Slippi folder, and keeps the games for later', () => {
    const none = host({ project: null })
    none.config.autoImportSlippi = true
    none.config.autoImportSlippiSince = T - 60_000
    slp(path.join(dir, 'Game_a.slp'), 100, T - 30_000)
    expect(new SlippiAutoImport(none.h).tick(T)).toEqual([])
    expect(none.config.autoImportSlippiSince).toBe(T - 60_000)
    const noDir = host({ slippi: null })
    noDir.config.autoImportSlippi = true
    noDir.config.autoImportSlippiSince = T - 60_000
    expect(new SlippiAutoImport(noDir.h).tick(T)).toEqual([])
  })
})
