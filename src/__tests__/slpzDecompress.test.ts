/**
 * @jest-environment node
 *
 * .slpz import decompression (lib/slpzDecompress.ts) with the slpz binary
 * Clipper bundles for this OS (release/app/slpz): the replay comes back byte
 * for byte, an existing replay is never written over, the same game already
 * decompressed is reused, and replace mode deletes the .slpz only once its
 * .slp is there. The whole import path is covered by
 * scripts/worker-check/slpzimport.js.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  decompressSlpzForImport,
  slpzDefaultOutputDir,
} from '../lib/slpzDecompress'
import { bundledBinaryName } from '../main/util'

jest.mock('electron', () => ({ app: {} }))

const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
let SLPZ: string | null = null
try {
  const p = path.resolve(
    __dirname,
    '../../release/app/slpz',
    bundledBinaryName('slpz'),
  )
  if (fs.existsSync(p)) SLPZ = p
} catch {
  SLPZ = null
}
describe('the SLPZ wizard default "extract to" folder', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-slpzdir-'))
    fs.mkdirSync(path.join(root, 'Replays', 'ranked'), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("a chosen folder: <folder>-slp next to it, not its parent's slp", async () => {
    const folder = path.join(root, 'Replays', 'ranked')
    expect(await slpzDefaultOutputDir([folder])).toBe(
      path.join(root, 'Replays', 'ranked-slp'),
    )
    // A trailing separator is the same folder.
    expect(await slpzDefaultOutputDir([`${folder}${path.sep}`])).toBe(
      path.join(root, 'Replays', 'ranked-slp'),
    )
  })

  it('chosen .slpz files: slp beside them', async () => {
    const file = path.join(root, 'Replays', 'ranked', 'game.slpz')
    expect(
      await slpzDefaultOutputDir([path.join(root, 'Replays', 'a.slp'), file]),
    ).toBe(path.join(root, 'Replays', 'ranked', 'slp'))
  })

  it('nothing chosen: no default', async () => {
    expect(await slpzDefaultOutputDir([])).toBe('')
  })
})

// The macOS binary is built on CI; without one there's nothing to run here.
const withSlpz = SLPZ ? describe : describe.skip

withSlpz('decompressSlpzForImport', () => {
  let root: string
  const bin = () => SLPZ as string
  const original = () => fs.readFileSync(REPLAY)
  /** A copy of the test replay that differs from it (another game). */
  const other = () => {
    const b = Buffer.from(original())
    const gameStart = 15 + 1 + b[16]
    b.writeUInt32BE(424242, gameStart + 0x13d)
    return b
  }
  const compress = (slp: string, slpz: string) =>
    execFileSync(bin(), ['-x', '-q', '-o', slpz, slp])

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-slpz-'))
    compress(REPLAY, path.join(root, 'game.slpz'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('replace: decompresses beside the .slpz and deletes it', () => {
    const out = decompressSlpzForImport(path.join(root, 'game.slpz'), {
      slpzBinaryPath: bin(),
      slpzMode: 'replace',
      slpzOutputDir: '',
    })
    expect(out).toBe(path.join(root, 'game.slp'))
    expect(fs.readFileSync(out).equals(original())).toBe(true)
    expect(fs.readdirSync(root)).toEqual(['game.slp'])
  })

  it('extract: writes into the folder and keeps the .slpz', () => {
    const outDir = path.join(root, 'out')
    const config = {
      slpzBinaryPath: bin(),
      slpzMode: 'extract' as const,
      slpzOutputDir: outDir,
    }
    const out = decompressSlpzForImport(path.join(root, 'game.slpz'), config)
    expect(out).toBe(path.join(outDir, 'game.slp'))
    expect(fs.existsSync(path.join(root, 'game.slpz'))).toBe(true)
    // Again: the same game is already there, reused as is.
    const again = decompressSlpzForImport(path.join(root, 'game.slpz'), config)
    expect(again).toBe(out)
    expect(fs.readdirSync(outDir)).toEqual(['game.slp'])
  })

  it('never writes over a different replay with the same name', () => {
    fs.writeFileSync(path.join(root, 'game.slp'), other())
    const out = decompressSlpzForImport(path.join(root, 'game.slpz'), {
      slpzBinaryPath: bin(),
      slpzMode: 'replace',
      slpzOutputDir: '',
    })
    expect(out).toBe(path.join(root, 'game-2.slp'))
    expect(fs.readFileSync(path.join(root, 'game.slp')).equals(other())).toBe(
      true,
    )
    expect(fs.readFileSync(out).equals(original())).toBe(true)
    // No temp files left behind.
    expect(fs.readdirSync(root).sort()).toEqual(['game-2.slp', 'game.slp'])
  })

  it('extract: a same-named game from another folder gets <folder>_<name>', () => {
    const outDir = path.join(root, 'out')
    fs.mkdirSync(outDir)
    fs.writeFileSync(path.join(outDir, 'game.slp'), other())
    const sub = path.join(root, 'week2')
    fs.mkdirSync(sub)
    fs.renameSync(path.join(root, 'game.slpz'), path.join(sub, 'game.slpz'))
    const out = decompressSlpzForImport(path.join(sub, 'game.slpz'), {
      slpzBinaryPath: bin(),
      slpzMode: 'extract',
      slpzOutputDir: outDir,
    })
    expect(out).toBe(path.join(outDir, 'week2_game.slp'))
    expect(fs.readFileSync(out).equals(original())).toBe(true)
  })

  it('a broken .slpz fails without leaving files or deleting it', () => {
    fs.writeFileSync(path.join(root, 'bad.slpz'), 'not slpz')
    expect(() =>
      decompressSlpzForImport(path.join(root, 'bad.slpz'), {
        slpzBinaryPath: bin(),
        slpzMode: 'replace',
        slpzOutputDir: '',
      }),
    ).toThrow(/bad\.slpz/)
    expect(fs.readdirSync(root).sort()).toEqual(['bad.slpz', 'game.slpz'])
  })
})
