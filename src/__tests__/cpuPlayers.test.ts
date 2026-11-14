/**
 * @jest-environment node
 *
 * Games with a CPU player: recorded at import, found in older games by the
 * background check's header reader, left out by the Game Filter unless
 * "Include CPU games" is on, and asked for from the Lunar Database only then.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  cpuChecked,
  headerKnowsCpu,
  HEADER_BYTES,
  isCpuGame,
  playerTypesFromHeader,
  withCpu,
} from '../lib/cpuPlayers'
import { fileProcessor } from '../models/File'
import filesFilter from '../models/methods/files'
import { filtersConfig } from '../constants/config'
import { archive as defaultArchive } from '../constants/defaults'
import {
  databaseExportFilter,
  databaseSearchBody,
  defaultDatabaseFilters,
  replayListExportBody,
  validateDatabaseFilters,
} from '../constants/database'
import {
  clipSearchBody,
  defaultClipSearch,
  validateClipSearch,
} from '../constants/clipSearch'
import type { FileInterface } from '../constants/types'

const REPLAY = path.resolve(__dirname, '../../assets/test.slp')

/**
 * A copy of the test replay with one port turned into a CPU: its Game Start
 * player type (offset 0x66 + 0x24 * port) set to 1, as the database's
 * __fixtures__/cpuFixture.ts does. The raw stream starts at byte 15; its first
 * event lists payload sizes (size at byte 16), and Game Start follows it.
 */
function writeCpuCopy(dest: string, port: number) {
  const b = Buffer.from(fs.readFileSync(REPLAY))
  const gameStart = 15 + 1 + b[16]
  if (b[15] !== 0x35 || b[gameStart] !== 0x36)
    throw new Error('unexpected fixture layout')
  b[gameStart + 0x66 + 0x24 * port] = 1
  fs.writeFileSync(dest, b)
  return dest
}

const head = (file: string) => {
  const b = Buffer.alloc(HEADER_BYTES)
  const fd = fs.openSync(file, 'r')
  const n = fs.readSync(fd, b, 0, HEADER_BYTES, 0)
  fs.closeSync(fd)
  return b.subarray(0, n)
}

let dir: string
let cpuReplay: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-cpu-'))
  // Port 2 (index 1) is the second player in the test replay.
  cpuReplay = writeCpuCopy(path.join(dir, 'cpu.slp'), 1)
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('reading player types from a replay header', () => {
  it('reads each port: humans, a CPU, empty ports', () => {
    expect(playerTypesFromHeader(head(REPLAY))).toEqual([0, 0, 3, 3])
    expect(playerTypesFromHeader(head(cpuReplay))).toEqual([0, 1, 3, 3])
  })
  it('refuses anything that is not the start of a replay', () => {
    expect(playerTypesFromHeader(new Uint8Array(0))).toBeNull()
    expect(playerTypesFromHeader(Buffer.from('not a replay at all'))).toBeNull()
    expect(playerTypesFromHeader(head(REPLAY).subarray(0, 100))).toBeNull()
    const bad = Buffer.from(head(REPLAY))
    bad[15] = 0x36
    expect(playerTypesFromHeader(bad)).toBeNull()
  })
})

describe('players with cpu', () => {
  const players = [
    { playerIndex: 0, displayName: 'a' },
    { playerIndex: 1, displayName: 'b' },
  ]
  it('marks players from the port types; unreadable means unknown', () => {
    expect(withCpu(players, [0, 1, 3, 3]).map((p) => p.cpu)).toEqual([
      false,
      true,
    ])
    expect(withCpu(players, null).map((p) => p.cpu)).toEqual([null, null])
  })
  it('counts only a known CPU; unknown is a human', () => {
    expect(isCpuGame(withCpu(players, [0, 1, 3, 3]))).toBe(true)
    expect(isCpuGame(withCpu(players, [0, 0, 3, 3]))).toBe(false)
    expect(isCpuGame(withCpu(players, null))).toBe(false)
    expect(isCpuGame(players)).toBe(false)
    expect(isCpuGame(null)).toBe(false)
  })
  it('knows which games were checked', () => {
    expect(cpuChecked(players)).toBe(false)
    expect(cpuChecked(withCpu(players, null))).toBe(true)
    expect(cpuChecked([])).toBe(false)
  })
  it('re-reads library headers from builds without cpu', () => {
    expect(headerKnowsCpu({ isValid: false, info: 'Bot' })).toBe(false)
    expect(headerKnowsCpu({ isValid: false, info: 'teams' })).toBe(true)
    expect(headerKnowsCpu({ isValid: true, players })).toBe(false)
    expect(
      headerKnowsCpu({ isValid: true, players: withCpu(players, [0, 0]) }),
    ).toBe(true)
  })
})

describe('import', () => {
  it('records cpu on every player', () => {
    const game = fileProcessor(REPLAY)
    expect(game.isValid).toBe(true)
    expect(game.players.map((p) => p.cpu)).toEqual([false, false])
  })
  it('imports a game with a CPU player (it used to be rejected) and marks it', () => {
    const game = fileProcessor(cpuReplay)
    expect(game.isValid).toBe(true)
    expect(game.info).not.toBe('Bot')
    expect(game.players.map((p) => p.cpu)).toEqual([false, true])
  })
})

describe('Game Filter', () => {
  const emit = () => {}
  const human = fileProcessor(REPLAY)
  const cpu = () => ({ ...fileProcessor(cpuReplay), path: 'cpu' })
  const older = (): FileInterface => ({
    ...human,
    path: 'older',
    // Imported before Clipper recorded cpu: not checked yet.
    players: human.players.map(({ cpu: _c, ...p }) => p),
  })
  const unknown = (): FileInterface => ({
    ...human,
    path: 'unknown',
    players: human.players.map((p) => ({ ...p, cpu: null })),
  })
  const games = () => [human, cpu(), older(), unknown()]
  const paths = (list: FileInterface[]) => list.map((g) => g.path)

  it('leaves CPU games out by default; unknown ones stay', () => {
    expect(paths(filesFilter(games(), {}, emit))).toEqual([
      REPLAY,
      'older',
      'unknown',
    ])
    expect(
      paths(filesFilter(games(), { includeCpu: false }, emit)),
    ).toHaveLength(3)
  })
  it('keeps them with Include CPU games on', () => {
    expect(paths(filesFilter(games(), { includeCpu: true }, emit))).toEqual([
      REPLAY,
      'cpu',
      'older',
      'unknown',
    ])
  })
  it('is a documented setting, off for new projects', () => {
    const options = filtersConfig.find((f) => f.id === 'files')!.options as {
      id: string
      type: string
      tooltip: string
    }[]
    const option = options.find((o) => o.id === 'includeCpu')!
    expect(option).toMatchObject({ type: 'checkbox', default: false })
    expect(option.tooltip).toMatch(/CPU/)
    const gameFilter = defaultArchive.filters.find((f) => f.type === 'files')!
    expect(gameFilter.params).toMatchObject({ includeCpu: false })
  })
})

describe('Lunar Database requests', () => {
  const filters = { ...defaultDatabaseFilters, maxFiles: 500 }
  it('ask for CPU games only when the toggle is on', () => {
    expect(databaseExportFilter(filters)).not.toHaveProperty('includeCpu')
    expect(databaseSearchBody(filters, 1, 25)).not.toHaveProperty('includeCpu')
    const on = { ...filters, includeCpu: true }
    expect(databaseExportFilter(on)).toMatchObject({ includeCpu: true })
    expect(databaseSearchBody(on, 2, 25)).toMatchObject({
      includeCpu: true,
      page: 2,
      numPerPage: 25,
    })
  })
  it('older saved filters have the toggle off; junk is refused', () => {
    const { includeCpu: _c, ...old } = filters
    expect(validateDatabaseFilters(old).includeCpu).toBe(false)
    expect(() =>
      validateDatabaseFilters({ ...filters, includeCpu: 'yes' as never }),
    ).toThrow()
  })
  it('a list of chosen replays always allows CPU games', () => {
    expect(replayListExportBody(['a'.repeat(24)])).toEqual({
      replayIds: ['a'.repeat(24)],
      includeCpu: true,
    })
  })
  it('clip search sends includeCpu only when on', () => {
    expect(clipSearchBody(defaultClipSearch, 1).includeCpu).toBeUndefined()
    const on = validateClipSearch({ ...defaultClipSearch, includeCpu: true })
    expect(clipSearchBody(on, 1).includeCpu).toBe(true)
    const { includeCpu: _c, ...old } = defaultClipSearch
    expect(validateClipSearch(old).includeCpu).toBe(false)
  })
})
