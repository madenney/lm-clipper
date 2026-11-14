/**
 * @jest-environment node
 *
 * The replay walk behind drag-and-drop and the file picker (lib/file.ts), and
 * the Slippi-folder count that must agree with it.
 */
import fs, { Dirent } from 'fs'
import os from 'os'
import path from 'path'
import { entryKind, streamSlpFilePaths } from '../lib/file'

let root: string
let outside: string

async function walk(paths: string[]) {
  const found: string[] = []
  for await (const p of streamSlpFilePaths(paths)) found.push(p)
  return found.map((p) => path.relative(root, p)).sort()
}

// What Windows' directory listing reports for a reparse point such as a
// OneDrive / cloud-synced file: neither a file nor a directory.
function reparseLike(name: string): Dirent {
  return {
    name,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => true,
  } as unknown as Dirent
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-walk-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-walk-out-'))
  fs.writeFileSync(path.join(root, 'game.slp'), 'x')
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
  fs.writeFileSync(path.join(root, 'cover.png'), 'x')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'UPPER.SLPZ'), 'x')
  fs.writeFileSync(path.join(root, 'sub', 'archive.zip'), 'x')
  fs.mkdirSync(path.join(root, 'sub', 'slp-not-a-file.slp'))
  fs.writeFileSync(path.join(outside, 'elsewhere.slp'), 'x')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('replay walk', () => {
  it('finds only .slp/.slpz files, at any depth, any case', async () => {
    expect(await walk([root])).toEqual([
      'game.slp',
      path.join('sub', 'UPPER.SLPZ'),
    ])
  })

  it('takes a single dropped replay and ignores a single non-replay', async () => {
    expect(await walk([path.join(root, 'game.slp')])).toEqual(['game.slp'])
    expect(await walk([path.join(root, 'notes.txt')])).toEqual([])
  })

  it('skips links found inside a folder but follows a dropped link', async () => {
    fs.symlinkSync(outside, path.join(root, 'link-dir'))
    fs.symlinkSync(
      path.join(outside, 'elsewhere.slp'),
      path.join(root, 'link.slp'),
    )
    // Inside the dropped folder: neither link is followed.
    expect(await walk([root])).toEqual([
      'game.slp',
      path.join('sub', 'UPPER.SLPZ'),
    ])
    // Dropped directly: the user chose it, so follow it.
    const direct = []
    for await (const p of streamSlpFilePaths([path.join(root, 'link-dir')]))
      direct.push(path.basename(p))
    expect(direct).toEqual(['elsewhere.slp'])
  })
})

describe('entry classification (Windows reparse points)', () => {
  it('asks lstat when the listing says neither file nor folder', async () => {
    const file = path.join(root, 'game.slp')
    const dir = path.join(root, 'sub')
    expect(await entryKind(reparseLike('game.slp'), file)).toBe('file')
    expect(await entryKind(reparseLike('sub'), dir)).toBe('dir')
  })

  it('still skips real symlinks and missing paths', async () => {
    const link = path.join(root, 'real-link')
    fs.symlinkSync(outside, link)
    expect(await entryKind(reparseLike('real-link'), link)).toBe('skip')
    const gone = path.join(root, 'gone')
    expect(await entryKind(reparseLike('gone'), gone)).toBe('skip')
  })
})
