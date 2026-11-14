/** @jest-environment node */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  extractReplayZip,
  safeArchivePath,
  decompressReplay,
} from '../main/replayExtraction'

// A tiny stored ZIP fixture builder lets tests exercise malicious central
// directory entries without depending on an installed system archiver.
function zipEntry(name: string, options: { crc?: number; mode?: number } = {}) {
  const filename = Buffer.from(name)
  const data = Buffer.from('hello')
  const crc = options.crc ?? 0x3610a686
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(0x0314, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(filename.length, 28)
  central.writeUInt32LE(((options.mode ?? 0x81a4) << 16) >>> 0, 38)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + data.length, 16)
  return Buffer.concat([local, filename, data, central, filename, end])
}

describe('replay extraction', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-extraction-test-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  function source(name: string, options?: { crc?: number; mode?: number }) {
    const file = path.join(root, 'source.zip')
    fs.writeFileSync(file, zipEntry(name, options))
    return file
  }
  it('extracts nested replays and preserves the source ZIP', async () => {
    const file = source('nested/game.slp')
    const original = fs.readFileSync(file)
    const progress = jest.fn()
    await expect(
      extractReplayZip(file, path.join(root, 'out'), { onProgress: progress }),
    ).resolves.toBe(1)
    expect(
      fs.readFileSync(path.join(root, 'out/nested/game.slp'), 'utf8'),
    ).toBe('hello')
    expect(fs.readFileSync(file)).toEqual(original)
    expect(progress).toHaveBeenCalledWith(1, 1, 'nested/game.slp')
  })
  it.each([
    '../escape.slp',
    '/absolute.slp',
    'C:/escape.slp',
    'folder/../../escape.slp',
  ])('rejects unsafe path %s', async (name) => {
    expect(() => safeArchivePath(path.join(root, 'out'), name)).toThrow()
    await expect(
      extractReplayZip(source(name), path.join(root, 'out')),
    ).rejects.toThrow()
  })
  it('rejects symlinks and corrupt contents', async () => {
    await expect(
      extractReplayZip(
        source('link.slp', { mode: 0xa1ff }),
        path.join(root, 'links'),
      ),
    ).rejects.toThrow(/link/)
    await expect(
      extractReplayZip(
        source('bad.slp', { crc: 1 }),
        path.join(root, 'corrupt'),
      ),
    ).rejects.toThrow(/checksum/)
  })
  it('never writes into an existing output directory', async () => {
    const out = path.join(root, 'out')
    fs.mkdirSync(out)
    fs.writeFileSync(path.join(out, 'game.slp'), 'keep')
    await expect(extractReplayZip(source('game.slp'), out)).rejects.toThrow()
    expect(fs.readFileSync(path.join(out, 'game.slp'), 'utf8')).toBe('keep')
  })
  it('cancels before writing and reports archives without replays', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      extractReplayZip(source('game.slp'), path.join(root, 'paused'), {
        signal: abort.signal,
      }),
    ).rejects.toThrow(/paused/)
    expect(fs.existsSync(path.join(root, 'paused'))).toBe(false)
    await expect(
      extractReplayZip(source('readme.txt'), path.join(root, 'empty')),
    ).rejects.toThrow(/No SLP/)
  })
  const binary = path.resolve(
    __dirname,
    '../../release/app/slpz/slpz-linux-x64',
  )
  const realReplay = path.resolve(__dirname, '../../assets/test.slp')
  const binaries =
    process.platform === 'linux' &&
    fs.existsSync(binary) &&
    fs.existsSync(realReplay)
      ? [binary]
      : []
  // Without the slpz binary (npm run build:slpz) this is skipped, not failed.
  const itWithSlpz = binaries.length ? it : it.skip
  itWithSlpz(
    'decompresses a real SLPZ with the bundled binary without removing its source',
    async () => {
      const compressed = path.join(root, 'game.slpz')
      const output = path.join(root, 'game.slp')
      execFileSync(binary, ['-x', '-o', compressed, realReplay])
      await decompressReplay(compressed, output, binary)
      expect(fs.existsSync(compressed)).toBe(true)
      // Buffer.equals, not toEqual: Jest's deep equality walks all 2.7 MB element by
      // element, which is what pushed this test past the default timeout.
      expect(fs.readFileSync(output).equals(fs.readFileSync(realReplay))).toBe(
        true,
      )
      await expect(
        decompressReplay(compressed, output, binary),
      ).rejects.toThrow()
    },
    30000,
  )
})
