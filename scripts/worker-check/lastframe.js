// Real-SQLite check for LastFrameScanWorker (src/main/LastFrameScanWorker.ts):
// older anonymized games stored with lastFrame -123 get their real length from
// the end of the replay, missing and unreadable replays are handled, Stop
// keeps what's done and a second run continues, the results rows copied from
// those games get the length too (also when a run stopped before them), and
// the footer's duration (selectionSql durationExpr) then counts them.
// Run: scripts/worker-check/run.sh
const { Worker } = require('worker_threads')
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

const OUT = process.env.OUT
const SCAN = path.join(OUT, 'out/main/LastFrameScanWorker.js')
const { durationExpr } = require(path.join(OUT, 'out/main/selectionSql.js'))
// An anonymized ranked game: empty metadata; its last frame is 6805.
const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
const LAST = 6805
const root = path.join(OUT, 'lastframe')
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`)
  if (!ok) failed++
}

const scan = (dbPath, opts = {}, onProgress) =>
  new Promise((resolve, reject) => {
    const w = new Worker(SCAN, { workerData: { dbPath, restMs: 0, ...opts } })
    const progress = []
    w.on('message', (m) => {
      if (m.type === 'progress') {
        progress.push(m)
        onProgress?.(m, w)
        return
      }
      if (m.type === 'done') resolve({ ...m, progress })
      else reject(new Error(m.message))
      w.terminate()
    })
    w.on('error', reject)
  })

const RESULTS = 'id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL'

;(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'replays'), { recursive: true })
  const junk = path.join(root, 'replays', 'junk.slp')
  fs.writeFileSync(junk, 'not a replay')
  const copies = []
  for (let i = 0; i < 30; i++) {
    const p = path.join(root, 'replays', `ranked-${i}.slp`)
    fs.copyFileSync(REPLAY, p)
    copies.push(p)
  }
  const dbPath = path.join(root, 'p.lunar')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT)')
  db.exec(`CREATE TABLE filter_games (${RESULTS})`)
  db.exec(`CREATE TABLE filter_clips (${RESULTS})`)
  db.exec('CREATE TABLE filter_runs (filter_id TEXT PRIMARY KEY, params_json TEXT, total_input INTEGER, status TEXT, created_at INTEGER)')
  const ins = db.prepare('INSERT INTO files (path, players, winner, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, \'[]\', 0, 31, 0, ?, 1, ?)')
  const rows = {
    ranked: ins.run(REPLAY, -123, 'Metadata removed').lastInsertRowid,
    known: ins.run(path.join(root, 'replays', 'never-read.slp'), 9000, '').lastInsertRowid,
    missing: ins.run(path.join(root, 'replays', 'gone.slp'), -123, 'Metadata removed').lastInsertRowid,
    goneFolder: ins.run(path.join(root, 'unplugged', 'a.slp'), -123, 'Metadata removed').lastInsertRowid,
    junk: ins.run(junk, -123, 'Metadata removed').lastInsertRowid,
  }
  for (const p of copies) ins.run(p, -123, 'Metadata removed')
  // Game Filter results as older builds wrote them (endFrame = lastFrame = -123),
  // and a combo clip that must not be touched.
  const gameRow = (p, lf) => JSON.stringify({ path: p, players: [], stage: 31, lastFrame: lf, startFrame: -123, endFrame: lf })
  const insGame = db.prepare('INSERT INTO filter_games (JSON) VALUES (?)')
  insGame.run(gameRow(REPLAY, -123))
  insGame.run(gameRow(path.join(root, 'replays', 'never-read.slp'), 9000))
  insGame.run(gameRow(path.join(root, 'replays', 'gone.slp'), -123))
  for (const p of copies) insGame.run(gameRow(p, -123))
  db.prepare('INSERT INTO filter_clips (JSON) VALUES (?)').run(JSON.stringify({ path: REPLAY, startFrame: 100, endFrame: 400 }))
  const lastOf = (id) => db.prepare('SELECT lastFrame FROM files WHERE id = ?').get(id).lastFrame
  const gameJson = (p) => JSON.parse(db.prepare("SELECT JSON FROM filter_games WHERE json_extract(JSON, '$.path') = ?").get(p).JSON)
  const marker = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'lastframe_results_pending'").get()
  const footer = (table) => {
    const cols = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name))
    return db.prepare(`SELECT SUM(${durationExpr(cols)}) AS f FROM "${table}"`).get().f
  }
  check('before: the footer has no duration for the anonymized games', footer('files') === 9000, String(footer('files')))

  // 1. Stop after the first batch: what's done stays done; results not yet.
  const stopped = await scan(dbPath, { batchSize: 4, restMs: 200 }, (m, w) => {
    if (m.checked > 0) w.postMessage({ type: 'stop' })
  })
  check('Stop ends the repair early', stopped.stopped === true && stopped.checked > 0 && stopped.checked < stopped.total, `${stopped.checked}/${stopped.total}`)
  check('a game read before Stop has its length', lastOf(rows.ranked) === LAST, String(lastOf(rows.ranked)))
  check('results wait while the files are not done', gameJson(REPLAY).lastFrame === -123 && marker())

  // 2. The next run continues and then fixes the results.
  const second = await scan(dbPath, { batchSize: 4, sliceSize: 7 })
  check('second run picks up only what was left', second.total === stopped.total - stopped.checked + stopped.missing, `${second.total}`)
  check('second run finishes', !second.stopped && second.checked === second.total)
  check('every copy got its length', copies.every((p) => db.prepare('SELECT lastFrame FROM files WHERE path = ?').get(p).lastFrame === LAST))
  check('missing replays are passed over (tried again later)', lastOf(rows.missing) === -123 && lastOf(rows.goneFolder) === -123)
  check('an unreadable replay is marked 0 (not read again)', lastOf(rows.junk) === 0, String(lastOf(rows.junk)))
  check('a game that had a length is untouched', lastOf(rows.known) === 9000)
  const g = gameJson(REPLAY)
  check('results rows of repaired games got lastFrame and endFrame', g.lastFrame === LAST && g.endFrame === LAST && g.startFrame === -123, JSON.stringify(g))
  check('every results copy fixed', second.resultsRows === copies.length + 1, String(second.resultsRows))
  check('results of a missing replay keep -123', gameJson(path.join(root, 'replays', 'gone.slp')).lastFrame === -123)
  check('other results rows are untouched', JSON.parse(db.prepare('SELECT JSON FROM filter_clips').get().JSON).endFrame === 400)
  check('the pending-results marker is gone', !marker())
  const expectFiles = 9000 + LAST * (copies.length + 1)
  check('the footer counts them now (files)', footer('files') === expectFiles, `${footer('files')} vs ${expectFiles}`)
  const expectGames = 9000 + 123 + (LAST + 123) * (copies.length + 1)
  check('the footer counts them now (Game Filter results)', footer('filter_games') === expectGames, `${footer('filter_games')} vs ${expectGames}`)

  // 3. Stopped during the results: the next run (nothing left in files) finishes them.
  db.prepare("UPDATE filter_games SET JSON = json_set(JSON, '$.lastFrame', -123, '$.endFrame', -123) WHERE json_extract(JSON, '$.path') = ?").run(REPLAY)
  db.exec('CREATE TABLE lastframe_results_pending (at INTEGER)')
  const third = await scan(dbPath)
  check('a pending results fix is finished with no games left to read', third.total === 2 && gameJson(REPLAY).lastFrame === LAST && !marker(), `${third.total}`)

  // 4. The missing-replays check's column: games marked missing aren't tried.
  db.exec('ALTER TABLE files ADD COLUMN missing INTEGER NOT NULL DEFAULT 0')
  db.prepare('UPDATE files SET missing = 1 WHERE id IN (?, ?)').run(rows.missing, rows.goneFolder)
  const fourth = await scan(dbPath)
  check('games marked missing are skipped', fourth.total === 0, String(fourth.total))
  db.close()
  if (failed) {
    console.log(`${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('all game length checks passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
