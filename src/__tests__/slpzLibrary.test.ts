/**
 * Replays kept as .slpz (lib/slpz.ts): the in-process codec against the
 * bundled slpz tool, every reader Clipper has (SlippiGame wrapper, header
 * read, last frame, CPU header, diskSpace footer), the decoded-copy cache for
 * Dolphin (main/slpCache.ts) and the import keep rule.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { execFileSync } from 'child_process'
import { SlippiGame as BaseSlippiGame } from '@slippi/slippi-js'
import {
  decodeSlpz,
  encodeSlpz,
  encodeSlpzVerified,
  looksLikeSlp,
  looksLikeSlpz,
  readReplayBytes,
  readSlpzHead,
  slpzHeaderSlp,
  slpzMetadata,
  slpzLastEventFrame,
  slpzSlpPrefix,
  SlpzError,
} from '../lib/slpz'
import { SlippiGame, openReplayHeader } from '../lib/slippiGame'
import { readLastFrame } from '../lib/lastFrame'
import { playerTypesFromHeader, HEADER_BYTES } from '../lib/cpuPlayers'
import { configureSlpCache, playableSlp, pruneSlpCache } from '../main/slpCache'
import { keepsSlpz } from '../lib/slpzDecompress'
import { libraryFileFor, libraryRelativePath } from '../main/replayLibrary'
import { fileProcessor } from '../models/File'

const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
const SLPZ_BIN = path.resolve(
  __dirname,
  '../../release/app/slpz/slpz-linux-x64',
)
const hasBin = process.platform === 'linux' && fs.existsSync(SLPZ_BIN)

let dir: string
let slp: Buffer
let slpz: Buffer
let slpzFile: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-slpz-lib-'))
  slp = fs.readFileSync(REPLAY)
  slpz = encodeSlpz(slp)
  slpzFile = path.join(dir, 'Game.slpz')
  fs.writeFileSync(slpzFile, slpz)
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('slpz codec', () => {
  it('round-trips byte for byte and is much smaller', () => {
    expect(decodeSlpz(slpz).equals(slp)).toBe(true)
    expect(slpz.length * 4).toBeLessThan(slp.length)
    expect(looksLikeSlpz(slpz)).toBe(true)
    expect(looksLikeSlp(slpz)).toBe(false)
    expect(looksLikeSlp(slp)).toBe(true)
  })
  it('decodes what the bundled slpz tool writes, and the tool decodes ours', () => {
    // The Linux tool only (Windows/macOS: the round trip above covers it).
    if (!hasBin) return
    const tool = execFileSync(SLPZ_BIN, ['-x', '-q', '-o', '-', REPLAY], {
      maxBuffer: 1 << 28,
    })
    expect(decodeSlpz(tool).equals(slp)).toBe(true)
    const back = execFileSync(SLPZ_BIN, ['-d', '-q', '-o', '-', '-'], {
      input: slpz,
      maxBuffer: 1 << 28,
    })
    expect(back.equals(slp)).toBe(true)
  })
  it('refuses what is not a .slpz, and a damaged one', () => {
    expect(() => decodeSlpz(slp)).toThrow(SlpzError)
    expect(() => decodeSlpz(Buffer.alloc(10))).toThrow(SlpzError)
    const cut = slpz.subarray(0, slpz.length - 100)
    expect(() => decodeSlpz(cut)).toThrow(SlpzError)
  })
  it('refuses a decompression bomb: a stream that inflates past its declared size', () => {
    // Keep the header (offsets and a small declared eventsSize) but swap the
    // zstd stream for one that expands to far more than declared.
    const header = Buffer.from(slpz.subarray(0, 24))
    const compressedOffset = header.readUInt32BE(16)
    const bomb = (
      zlib as unknown as { zstdCompressSync: (_b: Buffer) => Buffer }
    ).zstdCompressSync(Buffer.alloc(40 * 1024 * 1024))
    const crafted = Buffer.concat([slpz.subarray(0, compressedOffset), bomb])
    expect(crafted.readUInt32BE(20)).toBeLessThan(40 * 1024 * 1024)
    expect(() => decodeSlpz(crafted)).toThrow(SlpzError)
    // And a header that declares an absurd events size is refused up front.
    const huge = Buffer.from(slpz)
    huge.writeUInt32BE(0xfffffff0, 20)
    expect(() => decodeSlpz(huge)).toThrow(/too large/)
  })
  it('encodeSlpzVerified keeps a cut or odd .slp as .slp (null)', () => {
    expect(encodeSlpzVerified(slp)?.equals(slpz)).toBe(true)
    expect(encodeSlpzVerified(slp.subarray(0, 5000))).toBeNull()
    expect(encodeSlpzVerified(Buffer.from('not a replay'))).toBeNull()
  })
})

describe('reading a .slpz like a .slp', () => {
  it('SlippiGame opens a .slpz path with the same settings, metadata and frames', () => {
    const a = new BaseSlippiGame(REPLAY)
    const b = new SlippiGame(slpzFile)
    expect(b.getSettings()).toEqual(a.getSettings())
    expect(b.getMetadata()).toEqual(a.getMetadata())
    expect(Object.keys(b.getFrames()).length).toBe(
      Object.keys(a.getFrames()).length,
    )
    expect(readReplayBytes(slpzFile).equals(slp)).toBe(true)
  })
  it('header reads use the uncompressed head only', () => {
    const head = readSlpzHead(slpzFile)
    expect(head.length).toBeLessThan(slpz.length)
    const g = openReplayHeader(slpzFile)
    const a = new BaseSlippiGame(REPLAY)
    expect(g.getSettings()).toEqual(a.getSettings())
    expect(g.getMetadata()).toEqual(a.getMetadata())
    expect(new BaseSlippiGame(slpzHeaderSlp(head)).getSettings()).toEqual(
      a.getSettings(),
    )
  })
  it('import reads the same header from the .slp and the .slpz', () => {
    const a = fileProcessor(REPLAY)
    const b = fileProcessor(slpzFile)
    expect({ ...b, path: '' }).toEqual({ ...a, path: '' })
  })
  it('the last frame and the CPU header read from a .slpz', () => {
    expect(readLastFrame(slpzFile)).toBe(readLastFrame(REPLAY))
    // Straight from the compressed columns, no .slp rebuilt.
    expect(slpzLastEventFrame(slpz)).toBe(readLastFrame(REPLAY))
    expect(
      playerTypesFromHeader(slpzSlpPrefix(readSlpzHead(slpzFile))),
    ).toEqual(playerTypesFromHeader(slp.subarray(0, HEADER_BYTES)))
  })
  it('the metadata block is the .slp footer', () => {
    const meta = slpzMetadata(slpz)
    expect(slp.subarray(slp.length - meta.length).equals(meta)).toBe(true)
  })
  it('a .slp only named .slpz still reads', () => {
    const odd = path.join(dir, 'odd.slpz')
    fs.writeFileSync(odd, slp)
    expect(new SlippiGame(odd).getSettings()).toEqual(
      new BaseSlippiGame(REPLAY).getSettings(),
    )
    expect(openReplayHeader(odd).getSettings()?.stageId).toBe(
      new BaseSlippiGame(REPLAY).getSettings()?.stageId,
    )
  })
})

describe('decoded copies for Dolphin (slpCache)', () => {
  let cache: string
  beforeEach(() => {
    cache = path.join(dir, `cache-${Math.random().toString(36).slice(2)}`)
    configureSlpCache({ dir: cache, capBytes: 2 * 1024 * 1024 * 1024 })
  })

  it('passes a .slp through and decodes a .slpz once', async () => {
    expect(await playableSlp(REPLAY)).toBe(REPLAY)
    const [a, b] = await Promise.all([
      playableSlp(slpzFile),
      playableSlp(slpzFile),
    ])
    expect(a).toBe(b)
    expect(path.dirname(a)).toBe(cache)
    expect(a.endsWith('.slp')).toBe(true)
    expect(fs.readFileSync(a).equals(slp)).toBe(true)
    expect(fs.readdirSync(cache)).toHaveLength(1)
    // The source is untouched.
    expect(fs.readFileSync(slpzFile).equals(slpz)).toBe(true)
  })

  it('prunes old copies over the cap, never recent ones or other files', async () => {
    const copy = await playableSlp(slpzFile)
    const stranger = path.join(cache, 'keep-me.slp')
    fs.writeFileSync(stranger, 'not ours')
    configureSlpCache({ capBytes: 0 })
    // Recently used: kept even over the cap.
    expect(await pruneSlpCache()).toBe(0)
    expect(fs.existsSync(copy)).toBe(true)
    // An hour later it can go; the stranger never does.
    expect(await pruneSlpCache(Date.now() + 3600_000)).toBe(slp.length)
    expect(fs.existsSync(copy)).toBe(false)
    expect(fs.existsSync(stranger)).toBe(true)
  })
})

describe('library files', () => {
  it('names .slp and .slpz library paths and finds either', () => {
    const lib = path.join(dir, 'Library')
    const rid = 'ab'.repeat(12)
    expect(libraryRelativePath(rid)).toBe(
      path.join('replays', 'ab', `${rid}.slp`),
    )
    expect(libraryRelativePath(rid, '.slpz')).toBe(
      path.join('replays', 'ab', `${rid}.slpz`),
    )
    expect(libraryFileFor(lib, rid)).toBeNull()
    const z = path.join(lib, libraryRelativePath(rid, '.slpz'))
    fs.mkdirSync(path.dirname(z), { recursive: true })
    fs.writeFileSync(z, slpz)
    expect(libraryFileFor(lib, rid)).toBe(z)
  })

  it('import keeps a .slpz in keep mode and always inside the library', () => {
    const base = { slpzBinaryPath: '', slpzOutputDir: '' }
    const lib = path.join(dir, 'Library')
    const inLib = path.join(lib, 'replays', 'ab', 'x.slpz')
    expect(keepsSlpz('/a/b.slpz', { ...base, slpzMode: 'keep' })).toBe(true)
    expect(keepsSlpz('/a/b.slpz', { ...base, slpzMode: 'replace' })).toBe(false)
    expect(
      keepsSlpz(inLib, { ...base, slpzMode: 'replace', keepInside: lib }),
    ).toBe(true)
    expect(
      keepsSlpz(`${lib}-other/x.slpz`, {
        ...base,
        slpzMode: 'replace',
        keepInside: lib,
      }),
    ).toBe(false)
  })
})
