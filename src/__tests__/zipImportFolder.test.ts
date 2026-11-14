/**
 * @jest-environment node
 *
 * Where a ZIP import unpacks (main/zipImportFolder.ts): the same folder for
 * the same ZIP, so a second import of it adds nothing (the import itself is
 * checked end to end in scripts/worker-check/slpzimport.js).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { zipImportFolder, zipFingerprint } from '../main/zipImportFolder'
import { extractReplayZip } from '../main/replayExtraction'

let root: string
let staging: string

/** A ZIP of `files` (name -> text) under replays/, with Python's zipfile. */
function makeZip(zip: string, files: Record<string, string>) {
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging)
  for (const [name, text] of Object.entries(files))
    fs.writeFileSync(path.join(staging, name), text)
  execFileSync('python3', [
    '-c',
    'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor f in sorted(os.listdir(sys.argv[2])): z.write(os.path.join(sys.argv[2],f), "replays/"+f)\nz.close()',
    zip,
    staging,
  ])
  return zip
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-zipfolder-'))
  staging = path.join(root, 'staging')
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('zipImportFolder', () => {
  it('unpacks a ZIP once; importing it again reuses that folder', async () => {
    const zip = makeZip(path.join(root, 'games.zip'), {
      'a.slp': 'one',
      'b.slp': 'two',
    })
    const out = path.join(root, 'out')
    const extract = jest.fn((dir: string) => extractReplayZip(zip, dir))
    const first = await zipImportFolder(zip, out, extract)
    expect(first.reused).toBe(false)
    expect(
      fs.readdirSync(path.join(first.replaysDir, 'replays')).sort(),
    ).toEqual(['a.slp', 'b.slp'])
    const second = await zipImportFolder(zip, out, extract)
    expect(second).toEqual({ replaysDir: first.replaysDir, reused: true })
    expect(extract).toHaveBeenCalledTimes(1)
    // Named after the ZIP, with its fingerprint.
    expect(path.basename(path.dirname(first.replaysDir))).toBe(
      `games-${await zipFingerprint(zip)}`,
    )
  })

  it('a different ZIP gets its own folder; the same replays in another ZIP do not', async () => {
    const out = path.join(root, 'out')
    const a = makeZip(path.join(root, 'a.zip'), { 'x.slp': 'x' })
    const b = makeZip(path.join(root, 'b.zip'), { 'x.slp': 'changed' })
    const c = makeZip(path.join(root, 'c.zip'), { 'x.slp': 'x' })
    const extract = (zip: string) => (dir: string) => extractReplayZip(zip, dir)
    const fa = await zipImportFolder(a, out, extract(a))
    const fb = await zipImportFolder(b, out, extract(b))
    const fc = await zipImportFolder(c, out, extract(c))
    expect(fb.reused).toBe(false)
    expect(fb.replaysDir).not.toBe(fa.replaysDir)
    expect(fc).toEqual({ replaysDir: fa.replaysDir, reused: true })
  })

  it('a failed extraction leaves nothing; a half-done folder is unpacked again', async () => {
    const zip = makeZip(path.join(root, 'games.zip'), { 'a.slp': 'one' })
    const out = path.join(root, 'out')
    await expect(
      zipImportFolder(zip, out, async (dir) => {
        fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, 'partial.slp'), 'x')
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    expect(fs.readdirSync(out)).toEqual([])

    // A folder an interrupted run left (no marker): not reused, redone.
    const half = path.join(out, `games-${await zipFingerprint(zip)}`)
    fs.mkdirSync(path.join(half, 'replays'), { recursive: true })
    fs.writeFileSync(path.join(half, 'replays', 'stale.slp'), 'x')
    const done = await zipImportFolder(zip, out, (dir) =>
      extractReplayZip(zip, dir),
    )
    expect(done.reused).toBe(false)
    expect(fs.readdirSync(path.join(done.replaysDir, 'replays'))).toEqual([
      'a.slp',
    ])
  })
})
