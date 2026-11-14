// Real-SQLite check for MissingCheckWorker (src/main/MissingCheckWorker.ts):
// deleted files, a vanished folder, automatic repoint to another copy of the
// same recording, "download again" candidates, Locate…, and a file coming back.
// Run: scripts/worker-check/run.sh
const { Worker } = require('worker_threads')
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

const OUT = process.env.OUT
const L = require(path.join(OUT, 'out/main/replayLibrary.js'))
const WORKER = path.join(OUT, 'out/main/MissingCheckWorker.js')
const root = path.join(OUT, 'miss')
const lib = path.join(root, 'Library')
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`)
  if (!ok) failed++
}
const run = (mode, folder, libraryFolder = lib) =>
  new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { dbPath: path.join(root, 'p.lunar'), libraryFolder, mode, folder } })
    w.on('message', (m) => {
      if (m.type === 'progress') return
      if (m.type === 'done') resolve(m)
      else reject(new Error(m.message))
      w.terminate()
    })
    w.on('error', reject)
  })
const write = (p, body) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

;(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  const p = (rel) => path.join(root, rel)
  const files = {
    a: write(p('replays/a.slp'), 'game a'),
    b: write(p('replays/b.slp'), 'game b'),
    f: write(p('drive/Slippi/f.slp'), 'game f'),
    g: write(p('drive/Slippi/g.slp'), 'game g'),
    old: write(p('downloads-old/x.slp'), 'game x'),
  }
  const X = 'a'.repeat(24)
  const Y = 'b'.repeat(24)
  const xLib = write(path.join(lib, L.libraryRelativePath(X)), 'game x')
  const yLib = write(path.join(lib, L.libraryRelativePath(Y)), 'game y')
  files.y = yLib
  // The library knows every file; x has two copies (same recording).
  const seen = (f) => ({ path: f, size: fs.statSync(f).size, mtime: Math.floor(fs.statSync(f).mtimeMs), header: { isValid: true } })
  L.libraryRecordHeaders(lib, [files.a, files.b, files.f, files.g].map(seen))
  L.libraryRegister(lib, [
    { replayId: X, fileHash: 'hx', path: xLib },
    { replayId: X, fileHash: 'hx', path: files.old },
    { replayId: Y, fileHash: 'hy', path: yLib },
  ])
  L.closeLibraries()

  const db = new Database(p('p.lunar'))
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT)')
  db.exec('CREATE TABLE filter_1 (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER)')
  for (const k of ['a', 'b', 'f', 'g', 'old', 'y']) {
    db.prepare('INSERT INTO files (path) VALUES (?)').run(files[k])
    db.prepare('INSERT INTO filter_1 (JSON) VALUES (?)').run(JSON.stringify({ tag: k, path: files[k], startFrame: 1 }))
  }
  db.close()

  // b deleted, the "drive" unplugged, the old copy of x deleted, y's download deleted.
  fs.rmSync(files.b)
  fs.renameSync(p('drive'), p('drive-unplugged'))
  fs.rmSync(files.old)
  fs.rmSync(yLib)

  const { report } = await run('check')
  check('counts what is missing', report.total === 6 && report.missing === 4, `${report.missing} of ${report.total}`)
  check('repoints a game whose recording is still on disk elsewhere', report.repointed === 1)
  check('names the vanished folder', report.folders.length === 1 && report.folders[0].folder === p('drive') && report.folders[0].count === 2, JSON.stringify(report.folders))
  check('offers to download Lunar Database games again', JSON.stringify(report.downloadable) === JSON.stringify([Y]))
  const pdb = new Database(p('p.lunar'), { readonly: true })
  const clipX = JSON.parse(pdb.prepare("SELECT JSON FROM filter_1 WHERE json_extract(JSON, '$.tag') = 'old'").get().JSON)
  check('clips follow the repointed game', clipX.path === xLib && clipX.startFrame === 1)
  const flagged = pdb.prepare('SELECT COUNT(*) c FROM files WHERE missing = 1').get().c
  check('marks missing games in the project', flagged === 4)
  pdb.close()

  // The user finds the drive's replays in another folder: Locate…
  fs.mkdirSync(p('found'))
  fs.renameSync(p('drive-unplugged/Slippi'), p('found/Slippi'))
  const located = await run('locate', p('found'))
  check('Locate… finds moved replays', located.report.missing === 2 && located.report.folders.length === 0, `${located.report.missing} still missing`)
  const pdb2 = new Database(p('p.lunar'), { readonly: true })
  const clipF = JSON.parse(pdb2.prepare("SELECT JSON FROM filter_1 WHERE json_extract(JSON, '$.tag') = 'f'").get().JSON)
  check('...and their clips', clipF.path === p('found/Slippi/f.slp'))
  pdb2.close()

  const { ids } = await run('missingIds')
  check('lists the games Remove would take out', ids.length === 2)

  // b comes back.
  write(files.b, 'game b')
  const back = await run('check')
  check('a replay that comes back is no longer missing', back.report.missing === 1)

  // The Replay Library folder is moved in Settings: rename it (same drive) and
  // record the move as the app does; the project finds its library replays.
  const lib2 = path.join(root, 'MovedLibrary')
  fs.renameSync(lib, lib2)
  L.libraryRelocated(lib2, lib)
  L.closeLibraries()
  const afterMove = await run('check', undefined, lib2)
  const pdb3 = new Database(p('p.lunar'), { readonly: true })
  const clipOld = JSON.parse(pdb3.prepare("SELECT JSON FROM filter_1 WHERE json_extract(JSON, '$.tag') = 'old'").get().JSON)
  pdb3.close()
  check('after moving the library, its replays are found at the new place', afterMove.report.repointed === 1 && clipOld.path.startsWith(lib2), `${afterMove.report.repointed} repointed, ${afterMove.report.missing} missing`)
  const L2 = new Database(path.join(lib2, 'library.sqlite'), { readonly: true })
  const stale = L2.prepare('SELECT COUNT(*) c FROM paths WHERE substr(path, 1, ?) = ?').get(lib.length + 1, lib + path.sep).c
  L2.close()
  check("the library's own paths point at the new folder", stale === 0)

  console.log(failed ? `${failed} FAILED` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
