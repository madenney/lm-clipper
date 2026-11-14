// End-to-end check of .slpz import through the real import path
// (models/Archive.ts addFiles -> ImportWorker -> lib/slpzDecompress.ts ->
// models/File.ts, rows written by the DB worker), with the slpz binary Clipper
// bundles for this OS (release/app/slpz) and real replays compressed by it:
// replace mode, extract mode (and re-import), Skip, a folder holding both
// X.slp and X.slpz, an existing different replay never overwritten, and a ZIP
// of .slpz files unpacked first (main/replayExtraction.ts); the same ZIP
// imported twice adds nothing (main/zipImportFolder.ts); skipped files carry
// their reason (lib/importSkips.ts: a .slpz left out, a game that is not 1v1).
// Run: scripts/worker-check/run.sh
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const OUT = process.env.OUT
// The app's own packages first (yauzl 3, as webpack bundles it), then
// release/app's native ones (better-sqlite3 for Electron's ABI).
process.env.NODE_PATH = [path.join(OUT, 'out'), path.resolve(__dirname, '../../node_modules'), path.resolve(__dirname, '../../release/app/node_modules')].join(path.delimiter)
require('module').Module._initPaths()
const root = path.join(OUT, 'slpzimport')
const ASSET = path.resolve(__dirname, '../../assets/test.slp')
const BIN_DIR = path.resolve(__dirname, '../../release/app/slpz')
const binName = { linux: 'slpz-linux-x64', win32: 'slpz-win32-x64.exe', darwin: `slpz-darwin-${process.arch}` }[process.platform]
const SLPZ = path.join(BIN_DIR, binName)
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`)
  if (!ok) failed++
}

if (!fs.existsSync(SLPZ)) {
  console.log(`SKIP slpz import: no bundled ${binName} here (CI builds the macOS one)`)
  process.exit(0)
}

const { default: Archive } = require(path.join(OUT, 'out/models/Archive.js'))
const dbAsync = require(path.join(OUT, 'out/main/dbAsync.js'))
const { extractReplayZip } = require(path.join(OUT, 'out/main/replayExtraction.js'))
const { zipImportFolder } = require(path.join(OUT, 'out/main/zipImportFolder.js'))

// A ZIP of a folder's files under replays/ (Python's zipfile, as in 6).
const zipDir = (zip, dir) =>
  execFileSync('python3', ['-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor f in sorted(os.listdir(sys.argv[2])): z.write(os.path.join(sys.argv[2],f), "replays/"+f)\nz.close()', zip, dir])

// Three different files of the same game: the asset with its Game Start
// random seed changed, so each is its own replay.
function makeReplays(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const base = fs.readFileSync(ASSET)
  const gameStart = 15 + 1 + base[16]
  if (base[15] !== 0x35 || base[gameStart] !== 0x36) throw new Error('unexpected fixture layout')
  const names = []
  for (let i = 0; i < 3; i++) {
    const b = Buffer.from(base)
    b.writeUInt32BE(1000 + i, gameStart + 0x13d)
    const p = path.join(dir, `game${i}.slp`)
    fs.writeFileSync(p, b)
    names.push(p)
  }
  return names
}
const compress = (slp, slpz) => execFileSync(SLPZ, ['-x', '-q', '-o', slpz, slp])

let projectN = 0
async function project() {
  projectN++
  const p = path.join(root, `p${projectN}.lunar`)
  await dbAsync.createDBAsync(p, `p${projectN}`, false)
  return new Archive({ name: `p${projectN}`, path: p, createdAt: Date.now(), files: 0, filters: [] })
}
const rows = async (archive) => (await dbAsync.getAllFromTableAsync(archive.path, 'files')) || []
// One import worker: a worker terminated while it's still loading its modules
// (an import that ends before it got a file) can abort Electron's Node with
// "v8::ToLocalChecked Empty MaybeLocal". Files still run several at a time.
const run = (archive, paths, slpzConfig) =>
  archive.addFiles(paths, () => {}, { detectDuplicates: true, maxWorkers: 1, slpzConfig })

;(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  const originals = makeReplays(path.join(root, 'originals'))
  function config(mode, out = '') {
    return { slpzBinaryPath: SLPZ, slpzMode: mode, slpzOutputDir: out }
  }

  // 1. Replace mode: .slpz beside, decompressed in place, .slpz deleted.
  {
    const dir = path.join(root, 'replace')
    fs.mkdirSync(dir)
    for (const o of originals) compress(o, path.join(dir, path.basename(o) + 'z'))
    const a = await project()
    const r = await run(a, [dir], config('replace'))
    const files = fs.readdirSync(dir).sort()
    check('replace: every game imported', r.inserted === 3 && r.failed === 0, JSON.stringify(r))
    check('replace: .slpz turned into .slp', files.join() === 'game0.slp,game1.slp,game2.slp', files.join())
    check('replace: byte-identical to the originals', originals.every((o) => fs.readFileSync(o).equals(fs.readFileSync(path.join(dir, path.basename(o))))))
    const got = await rows(a)
    check('replace: rows point at the .slp with a length', got.length === 3 && got.every((f) => f.path.endsWith('.slp') && f.lastFrame === 6805), JSON.stringify(got.map((f) => [path.basename(f.path), f.lastFrame])))
  }

  // 2. Extract mode, then the same folder again: no second copy, no new rows.
  {
    const src = path.join(root, 'extract-src')
    const out = path.join(root, 'extract-out')
    fs.mkdirSync(src)
    for (const o of originals) compress(o, path.join(src, path.basename(o) + 'z'))
    const a = await project()
    const first = await run(a, [src], config('extract', out))
    check('extract: every game imported', first.inserted === 3 && first.failed === 0, JSON.stringify(first))
    check('extract: .slpz kept', fs.readdirSync(src).length === 3)
    check('extract: .slp in the output folder', fs.readdirSync(out).sort().join() === 'game0.slp,game1.slp,game2.slp', fs.readdirSync(out).join())
    const again = await run(a, [src], config('extract', out))
    check('extract again: all duplicates, nothing added', again.inserted === 0 && again.duplicates === 3, JSON.stringify(again))
    check('extract again: no second copies on disk', fs.readdirSync(out).length === 3, fs.readdirSync(out).join())
    check('extract again: still 3 rows', (await rows(a)).length === 3)
  }

  // 3. Skip .slpz files: left out, not failed.
  {
    const dir = path.join(root, 'skip')
    fs.mkdirSync(dir)
    compress(originals[0], path.join(dir, 'game0.slpz'))
    fs.copyFileSync(originals[1], path.join(dir, 'game1.slp'))
    const a = await project()
    const r = await run(a, [dir], undefined)
    check('skip: .slp imported, .slpz skipped (not failed)', r.inserted === 1 && r.skipped === 1 && r.failed === 0, JSON.stringify(r))
    check('skip: counted as a .slpz skip, for its own wording', r.skippedReasons && r.skippedReasons.slpz === 1 && Object.keys(r.skippedReasons).length === 1, JSON.stringify(r.skippedReasons))
    check('skip: .slpz untouched', fs.existsSync(path.join(dir, 'game0.slpz')))
  }

  // 4. A folder with both X.slp and X.slpz (same game): one row.
  {
    const dir = path.join(root, 'both')
    fs.mkdirSync(dir)
    fs.copyFileSync(originals[0], path.join(dir, 'game0.slp'))
    compress(originals[0], path.join(dir, 'game0.slpz'))
    const a = await project()
    const r = await run(a, [dir], config('replace'))
    check('both: one row for the same game', r.inserted === 1 && r.duplicates === 1, JSON.stringify(r))
    check('both: no extra copy', fs.readdirSync(dir).join() === 'game0.slp', fs.readdirSync(dir).join())
  }

  // 5. A different replay already has the name: never overwritten.
  {
    const dir = path.join(root, 'clash')
    fs.mkdirSync(dir)
    fs.copyFileSync(originals[1], path.join(dir, 'game0.slp'))
    compress(originals[0], path.join(dir, 'game0.slpz'))
    const a = await project()
    const r = await run(a, [path.join(dir, 'game0.slpz')], config('replace'))
    check('clash: imported under a free name', r.inserted === 1, JSON.stringify(r))
    check('clash: the other replay is untouched', fs.readFileSync(path.join(dir, 'game0.slp')).equals(fs.readFileSync(originals[1])))
    check('clash: the game is beside it', fs.existsSync(path.join(dir, 'game0-2.slp')) && fs.readFileSync(path.join(dir, 'game0-2.slp')).equals(fs.readFileSync(originals[0])), fs.readdirSync(dir).join())
  }

  // 6. A ZIP of .slpz files (a Lunar Database bundle style): unpacked, then imported.
  {
    const staging = path.join(root, 'zip-staging')
    fs.mkdirSync(staging)
    for (const o of originals) compress(o, path.join(staging, path.basename(o) + 'z'))
    const zip = path.join(root, 'bundle.zip')
    execFileSync('python3', ['-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor f in sorted(os.listdir(sys.argv[2])): z.write(os.path.join(sys.argv[2],f), "replays/"+f)\nz.close()', zip, staging])
    const dest = path.join(root, 'zip-out', 'replays')
    fs.mkdirSync(path.dirname(dest))
    const n = await extractReplayZip(zip, dest)
    check('zip: three .slpz extracted', n === 3)
    const a = await project()
    const r = await run(a, [dest], config('replace'))
    check('zip: every game imported', r.inserted === 3 && r.failed === 0, JSON.stringify(r))
  }

  // 7. The same ZIP imported twice (as ImportManager does it: zipImportFolder,
  // then the folder): the second time adds nothing and unpacks nothing; a
  // renamed copy of it is the same ZIP; a different ZIP gets its own folder.
  {
    const staging = path.join(root, 'zip2-staging')
    fs.mkdirSync(staging)
    for (const o of originals) fs.copyFileSync(o, path.join(staging, path.basename(o)))
    const zip = path.join(root, 'games.zip')
    zipDir(zip, staging)
    const out = path.join(root, 'zip2-out')
    let extractions = 0
    const extract = (z) => (dir) => {
      extractions += 1
      return extractReplayZip(z, dir)
    }
    const a = await project()
    const first = await zipImportFolder(zip, out, extract(zip))
    const r1 = await run(a, [first.replaysDir])
    check('zip twice: first import adds every game', r1.inserted === 3 && !first.reused, JSON.stringify(r1))
    const second = await zipImportFolder(zip, out, extract(zip))
    const r2 = await run(a, [second.replaysDir])
    check('zip twice: same folder, not unpacked again', second.reused && second.replaysDir === first.replaysDir && extractions === 1, JSON.stringify(second))
    check('zip twice: second import adds nothing', r2.inserted === 0 && r2.duplicates === 3, JSON.stringify(r2))
    check('zip twice: still 3 rows', (await rows(a)).length === 3)
    const renamed = path.join(root, 'games (1).zip')
    fs.copyFileSync(zip, renamed)
    const third = await zipImportFolder(renamed, out, extract(renamed))
    const r3 = await run(a, [third.replaysDir])
    check('zip twice: a renamed copy is the same ZIP', third.reused && r3.inserted === 0 && extractions === 1, JSON.stringify(r3))
    // Another ZIP (one replay fewer): its own folder.
    fs.rmSync(path.join(staging, 'game2.slp'))
    const other = path.join(root, 'games.zip.other.zip')
    zipDir(other, staging)
    const fourth = await zipImportFolder(other, out, extract(other))
    check('zip twice: a different ZIP is unpacked on its own', !fourth.reused && fourth.replaysDir !== first.replaysDir && extractions === 2)
    check('zip twice: one folder per ZIP in the output folder', fs.readdirSync(out).length === 2, fs.readdirSync(out).join())
  }

  // 8. A game that isn't 1v1 (a third player): skipped, and counted as such.
  {
    const dir = path.join(root, 'not1v1')
    fs.mkdirSync(dir)
    const b = Buffer.from(fs.readFileSync(originals[0]))
    const gameStart = 15 + 1 + b[16]
    // Port 3: a human player (type 0) playing Fox (external id 2).
    b[gameStart + 0x65 + 2 * 0x24] = 2
    b[gameStart + 0x66 + 2 * 0x24] = 0
    fs.writeFileSync(path.join(dir, 'three.slp'), b)
    fs.copyFileSync(originals[1], path.join(dir, 'game1.slp'))
    const a = await project()
    const r = await run(a, [dir])
    check('not 1v1: skipped with its reason', r.inserted === 1 && r.skipped === 1 && r.skippedReasons && r.skippedReasons.not1v1 === 1, JSON.stringify(r))
  }

  // 9. Keep compressed (the default slpzMode): .slpz imported as they are,
  // nothing written or deleted; the same folder again adds nothing.
  {
    const dir = path.join(root, 'keep')
    fs.mkdirSync(dir)
    for (const o of originals) compress(o, path.join(dir, path.basename(o) + 'z'))
    const before = fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs])
    const a = await project()
    const r = await run(a, [dir], config('keep'))
    check('keep: every game imported', r.inserted === 3 && r.failed === 0, JSON.stringify(r))
    const after = fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs])
    check('keep: the folder is untouched', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))
    const got = await rows(a)
    check('keep: rows point at the .slpz with a length', got.length === 3 && got.every((f) => f.path.endsWith('.slpz') && f.lastFrame === 6805), JSON.stringify(got.map((f) => [path.basename(f.path), f.lastFrame])))
    const again = await run(a, [dir], config('keep'))
    check('keep again: all duplicates', again.inserted === 0 && again.duplicates === 3, JSON.stringify(again))
  }

  // 10. Replace mode never touches Clipper's own library (keepInside): its
  // downloaded .slpz files are imported as they are.
  {
    const lib = path.join(root, 'Library')
    const dir = path.join(lib, 'replays', 'ab')
    fs.mkdirSync(dir, { recursive: true })
    compress(originals[0], path.join(dir, `${'ab'.repeat(12)}.slpz`))
    const a = await project()
    const r = await run(a, [dir], { ...config('replace'), keepInside: lib })
    check('library: imported without decompressing', r.inserted === 1 && fs.readdirSync(dir).join() === `${'ab'.repeat(12)}.slpz`, JSON.stringify(r) + ' ' + fs.readdirSync(dir).join())
  }

  await dbAsync.shutdownDbWorker()
  if (failed) {
    console.log(`${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('all slpz import checks passed')
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
