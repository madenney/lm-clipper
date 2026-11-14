// Real-SQLite check for deleting from the tray, through the real DbWorker
// (src/main/removeRows.ts, src/main/replayLibrary.ts libraryForget):
//  - Replays tray: the games leave the project, every step's rows made from
//    them, My Replays (another project file) and the replay library's index,
//    so Find replays no longer finds them "in your library";
//  - a filter step's tray: those results and what later steps made from them;
//  - cached counts stay true;
//  - no file on disk is deleted, moved or changed: not the replays downloaded
//    into the library folder, not the user's own, not a symlinked one.
// Run: scripts/worker-check/run.sh
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { Worker } = require('worker_threads')

const OUT = process.env.OUT
const lib = require(path.join(OUT, 'out/main/replayLibrary.js'))
const { RESULTS_TABLE_COLUMNS } = require(path.join(OUT, 'out/main/overview.js'))
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`)
  if (!ok) failed++
}

const root = path.join(OUT, 'remove')
fs.rmSync(root, { recursive: true, force: true })
const libraryDir = path.join(root, 'Library')
const ownDir = path.join(root, 'Slippi')
const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
const replayIds = Array.from({ length: 6 }, (_, i) => `aaaaaaaaaaaaaaaaaaaaaa${String(10 + i)}`)

// Downloaded replays (inside the library folder) and the user's own.
const downloaded = replayIds.map((id) => {
  const p = path.join(libraryDir, lib.libraryRelativePath(id))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.copyFileSync(REPLAY, p)
  return p
})
fs.mkdirSync(ownDir, { recursive: true })
const own = Array.from({ length: 4 }, (_, i) => {
  const p = path.join(ownDir, `Game_${i}.slp`)
  fs.copyFileSync(REPLAY, p)
  return p
})
// One of the user's replays through a symlinked folder.
fs.symlinkSync(ownDir, path.join(root, 'linked'))
const linked = path.join(root, 'linked', 'Game_3.slp')
const games = [...downloaded, ...own.slice(0, 3), linked]

lib.libraryRegister(
  libraryDir,
  replayIds.map((replayId, i) => ({ replayId, fileHash: `h${i}`, path: downloaded[i] })),
)
lib.libraryRecordHeaders(
  libraryDir,
  [...own.slice(0, 3), linked].map((p) => {
    const st = fs.statSync(p)
    return { path: p, size: st.size, mtime: st.mtimeMs, header: { stage: 31 } }
  }),
)
lib.closeLibraries()

/** Every file and link under root: path -> size, mtime, inode (or link target). */
function snapshot() {
  const out = {}
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      // The databases change, of course; the replay files must not.
      if (e.name.startsWith('library.sqlite') || /\.lunar(-wal|-shm)?$/.test(e.name)) continue
      if (e.isSymbolicLink()) out[p] = `link -> ${fs.readlinkSync(p)}`
      else if (e.isDirectory()) walk(p)
      else {
        const st = fs.statSync(p)
        out[p] = `${st.size} ${st.mtimeMs} ${st.ino}`
      }
    }
  }
  walk(root)
  return out
}

const steps = [
  { id: 'filter_0', type: 'files' },
  { id: 'combos', type: 'slpParser' },
  { id: 'sorted', type: 'sort' },
]
function makeProject(file) {
  const db = new Database(file)
  db.exec(`
    CREATE TABLE metadata (name TEXT NOT NULL, path TEXT NOT NULL, createdAt INTEGER NOT NULL, extra TEXT DEFAULT '{}');
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT);
  `)
  for (const s of steps) db.exec(`CREATE TABLE "${s.id}" (${RESULTS_TABLE_COLUMNS})`)
  const ins = (t, j) => Number(db.prepare(`INSERT INTO "${t}" (JSON) VALUES (?)`).run(JSON.stringify(j)).lastInsertRowid)
  games.forEach((p, i) => {
    const id = Number(db.prepare('INSERT INTO files (path, stage, lastFrame) VALUES (?, 31, 5000)').run(p).lastInsertRowid)
    const row = ins('filter_0', { id, path: p, _sourceId: id })
    for (const k of [0, 1]) ins('combos', { path: p, startFrame: k * 100, endFrame: k * 100 + 60 + i, _sourceId: row })
  })
  db.exec("INSERT INTO sorted (JSON) SELECT JSON FROM combos ORDER BY JSON_EXTRACT(JSON, '$.endFrame') DESC")
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
  db.prepare('INSERT INTO metadata VALUES (?, ?, 0, ?)').run(
    'p',
    file,
    JSON.stringify({
      filters: steps,
      cachedFileCount: count('files'),
      cachedCounts: Object.fromEntries(steps.map((s) => [s.id, count(s.id)])),
    }),
  )
  db.close()
}
const project = path.join(root, 'project.lunar')
const myReplays = path.join(root, 'My Replays.lunar')
makeProject(project)
makeProject(myReplays)
const before = snapshot()

const worker = new Worker(path.join(OUT, 'out/main/DbWorker.js'))
let nextId = 1
const pending = new Map()
worker.on('message', (m) => {
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.type === 'error') p.reject(new Error(m.error))
  else p.resolve(m.data)
})
const call = (dbPath, method, extra = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, dbPath, method, ...extra })
  })
const libraryCall = (fn, ...args) => call('', 'library', { fn, args })

const counts = (file) => {
  const db = new Database(file, { readonly: true })
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
  const extra = JSON.parse(db.prepare('SELECT extra FROM metadata').get().extra)
  const out = {
    rows: { files: n('files'), ...Object.fromEntries(steps.map((s) => [s.id, n(s.id)])) },
    cached: { files: extra.cachedFileCount, ...extra.cachedCounts },
    paths: db.prepare('SELECT path FROM files').all().map((r) => r.path),
  }
  db.close()
  return out
}

;(async () => {
  try {
    // ── Replays tray: 2 downloaded, 1 own, the symlinked one ──
    const db0 = new Database(project, { readonly: true })
    const pick = [downloaded[0], downloaded[1], own[0], linked]
    const fileIds = pick.map((p) => db0.prepare('SELECT id FROM files WHERE path = ?').get(p).id)
    db0.close()
    const paths = await call(project, 'removeGames', { fileIds, filterIds: steps.map((s) => s.id) })
    check('removeGames returns the games\' paths', JSON.stringify([...paths].sort()) === JSON.stringify([...pick].sort()))
    const forgotten = await libraryCall('libraryForget', libraryDir, paths)
    check('the library forgets those 4 games', forgotten === 4, `forgot ${forgotten}`)
    const fromMy = await call('', 'removeGamesFromProjectFile', { projectPath: myReplays, paths })
    check('My Replays loses them too', fromMy === 4, `removed ${fromMy}`)

    const total = games.length
    for (const [name, file] of [['project', project], ['My Replays', myReplays]]) {
      const c = counts(file)
      check(`${name}: games and every step's rows made from them are gone`,
        c.rows.files === total - 4 && c.rows.filter_0 === total - 4 &&
          c.rows.combos === 2 * (total - 4) && c.rows.sorted === 2 * (total - 4),
        JSON.stringify(c.rows))
      check(`${name}: cached counts match the tables`, JSON.stringify(c.rows) === JSON.stringify(c.cached), JSON.stringify(c.cached))
      check(`${name}: none of the removed games is left`, !c.paths.some((p) => pick.includes(p)))
    }

    const look = await libraryCall('libraryLookup', libraryDir, replayIds, [])
    check('Find replays: removed downloads are no longer "in your library"',
      !look.have[replayIds[0]] && !look.have[replayIds[1]] && look.missing.includes(replayIds[0]))
    check('Find replays: the other downloads still are', replayIds.slice(2).every((id) => look.have[id] === downloaded[replayIds.indexOf(id)]))
    const summary = await libraryCall('librarySummary', libraryDir)
    check('the library keeps the games not removed', summary.games === games.length - 4 && summary.fromDatabase === 4, JSON.stringify(summary))

    // ── A filter step's tray: two combos of one game ──
    const db1 = new Database(project, { readonly: true })
    const combo = db1.prepare("SELECT id FROM combos WHERE JSON_EXTRACT(JSON, '$.path') = ?").all(downloaded[3]).map((r) => r.id)
    db1.close()
    const filesBefore = counts(project).rows.files
    const removed = await call(project, 'removeResultsCascade', { tableId: 'combos', rowIds: combo, downstream: steps.slice(2) })
    check('a step\'s results go with their copies downstream', removed.combos === 2 && removed.sorted === 2, JSON.stringify(removed))
    const c = counts(project)
    check('...and no game goes', c.rows.files === filesBefore && c.rows.filter_0 === filesBefore)
    check('...and the cached counts match', JSON.stringify(c.rows) === JSON.stringify(c.cached))

    // ── Disk ──
    const after = snapshot()
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k])
    check('no file on disk was deleted, moved or changed', changed.length === 0, changed.slice(0, 5).join(', '))
    check('the downloaded files are still in the library folder', downloaded.every((p) => fs.existsSync(p)))
    check('the user\'s own files (and the symlinked one) are still there', own.every((p) => fs.existsSync(p)) && fs.existsSync(linked))
  } catch (err) {
    check('remove checks ran', false, err.stack)
  } finally {
    await worker.terminate()
    console.log(failed ? `remove: ${failed} FAILED` : 'remove: all passed')
    process.exit(failed ? 1 : 0)
  }
})()
