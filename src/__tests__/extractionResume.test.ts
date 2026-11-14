/**
 * @jest-environment node
 *
 * Unpacking archives on Windows and resuming a paused unpack (launch review
 * WIN-7, WIN-8, WIN-19, DL-8, DL-22, DL-23).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  crc32Update,
  extractReplayFiles,
  extractReplayZip,
  portableSegment,
  safeArchivePath,
} from '../main/replayExtraction'

type Entry = { name: string; data?: string }

/** A stored (uncompressed) ZIP with these entries. */
function zipOf(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const data = Buffer.from(e.data ?? 'hello')
    const crc = crc32Update(0, data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0x81a4 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-extract-resume-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const zipFile = (entries: Entry[]) => {
  const file = path.join(root, 'in.zip')
  fs.writeFileSync(file, zipOf(entries))
  return file
}
const tree = (dir: string, rel = ''): string[] =>
  fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`],
    )
    .sort()

describe('Windows-safe names', () => {
  it.each([
    ['Genesis 9: Pools', 'Genesis 9_ Pools'],
    ['a<b>c"d|e?f*g', 'a_b_c_d_e_f_g'],
    ['trailing. ', 'trailing'],
    ['CON', '_CON'],
    ['nul.slp', '_nul.slp'],
    ['COM1', '_COM1'],
    ['ok name', 'ok name'],
    ['...', '_'],
  ])('win32 segment %p -> %p', (name, expected) => {
    expect(portableSegment(name, 'win32')).toBe(expected)
  })

  it('keeps a colon on Linux, replaces it on macOS', () => {
    expect(portableSegment('Genesis 9: Pools', 'linux')).toBe(
      'Genesis 9: Pools',
    )
    expect(portableSegment('Genesis 9: Pools', 'darwin')).toBe(
      'Genesis 9_ Pools',
    )
  })

  it('maps a full database path instead of refusing it, and still refuses escapes', () => {
    const out = path.join(root, 'out')
    expect(
      path.relative(
        out,
        safeArchivePath(out, 'tournament/Genesis 9: Pools/g.slp', 'win32'),
      ),
    ).toBe(path.join('tournament', 'Genesis 9_ Pools', 'g.slp'))
    for (const name of ['../x.slp', '/abs.slp', 'C:/x.slp', 'a/../../x.slp'])
      expect(() => safeArchivePath(out, name, 'win32')).toThrow(/unsafe/)
  })

  it('extracts a zip with ":" and "?" in names on win32, keeping names that differ only by case apart', async () => {
    const file = zipFile([
      { name: 'tournament/Genesis 9: Pools/a.slp', data: 'A' },
      { name: 'tournament/genesis 9_ pools/a.slp', data: 'B' },
      { name: 'tournament/what?/b.slp', data: 'C' },
    ])
    const out = path.join(root, 'out')
    const n = await extractReplayZip(file, out, { platform: 'win32' })
    expect(n).toBe(3)
    // Case-insensitive twin gets a suffix instead of failing with EEXIST; all three survive.
    expect(tree(out).length).toBe(3)
    const contents = tree(out).map((p) =>
      fs.readFileSync(path.join(out, p), 'utf8'),
    )
    expect(contents.sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('what a zip may hold', () => {
  it('ignores non-replay entries however odd their names, instead of failing the run', async () => {
    const file = zipFile([
      { name: 'notes: final.txt' },
      { name: '__MACOSX/._a.slp.txt' },
      { name: 'dir/' },
      { name: 'game.slp', data: 'G' },
    ])
    const out = path.join(root, 'out')
    expect(await extractReplayZip(file, out)).toBe(1)
    expect(tree(out)).toEqual(['game.slp'])
  })

  it('reads backslash separators (older Windows tools) as folders', async () => {
    const file = zipFile([{ name: 'Slippi\\2026-11\\game.slp', data: 'G' }])
    const out = path.join(root, 'out')
    expect(await extractReplayZip(file, out)).toBe(1)
    expect(tree(out)).toEqual(['Slippi/2026-11/game.slp'])
  })
})

describe('resuming a paused unpack', () => {
  const entries = [
    { name: 'a.slp', data: 'AAA' },
    { name: 'b/b.slp', data: 'BBB' },
    { name: 'c.slp', data: 'CCC' },
  ]

  it('leaves only whole replays under their real names when stopped half way', async () => {
    const file = zipFile(entries)
    const out = path.join(root, 'out')
    const abort = new AbortController()
    await expect(
      extractReplayZip(file, out, {
        signal: abort.signal,
        onProgress: (current) => {
          if (current === 2) abort.abort()
        },
      }),
    ).rejects.toThrow(/paused|aborted/)
    // The folder is still there (nothing deletes it) and holds no half-written file.
    expect(fs.existsSync(out)).toBe(true)
    expect(tree(out).every((p) => !p.endsWith('.part'))).toBe(true)
    expect(tree(out)).toContain('a.slp')
  })

  it('Resume skips what is already there and finishes the rest', async () => {
    const file = zipFile(entries)
    const out = path.join(root, 'out')
    fs.mkdirSync(out)
    fs.writeFileSync(path.join(out, 'a.slp'), 'AAA')
    // A stale half file from a hard kill is replaced, not mistaken for a replay.
    fs.mkdirSync(path.join(out, 'b'))
    fs.writeFileSync(path.join(out, 'b', 'b.slp.part'), 'half')
    // Without resume an existing folder is still refused.
    await expect(extractReplayZip(file, out)).rejects.toThrow()
    const before = fs.statSync(path.join(out, 'a.slp')).mtimeMs
    expect(await extractReplayZip(file, out, { resume: true })).toBe(3)
    expect(tree(out)).toEqual(['a.slp', 'b/b.slp', 'c.slp'])
    expect(fs.readFileSync(path.join(out, 'b/b.slp'), 'utf8')).toBe('BBB')
    expect(fs.statSync(path.join(out, 'a.slp')).mtimeMs).toBe(before)
  })

  it('extractReplayFiles resumes a folder of replays the same way', async () => {
    const src = path.join(root, 'src')
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, 'one.slp'), 'ONE')
    fs.writeFileSync(path.join(src, 'two.slp'), 'TWO')
    const out = path.join(root, 'out')
    const first = await extractReplayFiles([src], out, '/none')
    expect(first).toBe(2)
    await expect(extractReplayFiles([src], out, '/none')).rejects.toThrow()
    fs.rmSync(path.join(out, '1', 'src', 'two.slp'))
    expect(
      await extractReplayFiles([src], out, '/none', undefined, undefined, {
        resume: true,
      }),
    ).toBe(2)
    expect(fs.readFileSync(path.join(out, '1', 'src', 'two.slp'), 'utf8')).toBe(
      'TWO',
    )
  })
})

describe('crc32Update', () => {
  it('matches zlib over chunks', () => {
    const data = Buffer.from('some replay bytes '.repeat(100))
    const whole = crc32Update(0, data)
    const parts = crc32Update(
      crc32Update(0, data.subarray(0, 700)),
      data.subarray(700),
    )
    expect(parts).toBe(whole)
    expect(crc32Update(0, Buffer.from('hello'))).toBe(0x3610a686)
  })
})
