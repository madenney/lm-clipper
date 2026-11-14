// Real-SQLite check for CpuScanWorker (src/main/CpuScanWorker.ts) and the Game
// Filter's "Include CPU games" (src/models/methods/files.ts run by Worker.ts):
// older games get cpu from their replay headers, a CPU game is found, missing
// and unreadable replays are handled, Stop keeps what's done and a second run
// continues, and the Game Filter leaves CPU games out unless asked.
// Run: scripts/worker-check/run.sh
const { Worker } = require('worker_threads')
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

const OUT = process.env.OUT
const SCAN = path.join(OUT, 'out/main/CpuScanWorker.js')
const FILTER = path.join(OUT, 'out/models/Worker.js')
const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
const root = path.join(OUT, 'cpu')
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`)
  if (!ok) failed++
}

// One port of the test replay turned into a CPU (as the database's
// __fixtures__/cpuFixture.ts does): Game Start player type at 0x66 + 0x24 * port.
function writeCpuCopy(dest, port) {
  const b = Buffer.from(fs.readFileSync(REPLAY))
  const gameStart = 15 + 1 + b[16]
  if (b[15] !== 0x35 || b[gameStart] !== 0x36) throw new Error('unexpected fixture layout')
  b[gameStart + 0x66 + 0x24 * port] = 1
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, b)
  return dest
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

const filter = (dbPath, params, top) =>
  new Promise((resolve, reject) => {
    const w = new Worker(FILTER, {
      workerData: { dbPath, prevTableId: 'files', nextTableId: 'out', type: 'files', slice: { bottom: 1, top }, params, skipSourceIds: [] },
    })
    w.on('message', (m) => {
      if (m.type === 'done') {
        resolve(m)
        w.terminate()
      }
    })
    w.on('error', reject)
  })

const player = (i) => ({ playerIndex: i, port: i + 1, characterId: 2, characterColor: 0, nametag: '', displayName: 'P' + i, connectCode: 'P#' + i })

;(async () => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  const cpuReplay = writeCpuCopy(path.join(root, 'replays', 'cpu.slp'), 1)
  const junk = path.join(root, 'replays', 'junk.slp')
  fs.writeFileSync(junk, 'not a replay')
  const dbPath = path.join(root, 'p.lunar')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT)')
  db.exec('CREATE TABLE out (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = db.prepare('INSERT INTO files (path, players, winner, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, ?, 0, 31, 0, 5000, 1, \'\')')
  const older = JSON.stringify([player(0), player(1)])
  const rows = {
    human: ins.run(REPLAY, older).lastInsertRowid,
    cpu: ins.run(cpuReplay, older).lastInsertRowid,
    missing: ins.run(path.join(root, 'replays', 'gone.slp'), older).lastInsertRowid,
    goneFolder: ins.run(path.join(root, 'unplugged', 'a.slp'), older).lastInsertRowid,
    junk: ins.run(junk, older).lastInsertRowid,
    // Imported by this build: already has cpu, never read again.
    known: ins.run(path.join(root, 'replays', 'never-read.slp'), JSON.stringify([{ ...player(0), cpu: false }, { ...player(1), cpu: true }])).lastInsertRowid,
  }
  // Many more older games, so Stop lands mid-way.
  for (let i = 0; i < 30; i++) ins.run(REPLAY, older)
  const total = db.prepare('SELECT COUNT(*) c FROM files').get().c
  const cpuOf = (id) => JSON.parse(db.prepare('SELECT players FROM files WHERE id = ?').get(id).players).map((p) => p.cpu)

  // 1. Stop after the first batch: what's done stays done.
  const stopped = await scan(dbPath, { batchSize: 4, restMs: 200 }, (m, w) => {
    if (m.checked > 0) w.postMessage({ type: 'stop' })
  })
  const firstChecked = stopped.checked
  check('Stop ends the check early', stopped.stopped === true && firstChecked > 0 && firstChecked < stopped.total, `${firstChecked}/${stopped.total}`)
  check('older games before Stop got cpu', JSON.stringify(cpuOf(rows.human)) === '[false,false]' && JSON.stringify(cpuOf(rows.cpu)) === '[false,true]')

  // 2. The next run continues: only games not checked yet.
  const second = await scan(dbPath, { batchSize: 4 })
  check('second run picks up only what was left', second.total === stopped.total - firstChecked + stopped.missing, `${second.total}`)
  check('second run finishes', !second.stopped && second.checked === second.total)
  check('a game with a CPU player is found', JSON.stringify(cpuOf(rows.cpu)) === '[false,true]')
  check('missing replays are passed over (unknown, tried again later)', cpuOf(rows.missing).every((v) => v === undefined) && cpuOf(rows.goneFolder).every((v) => v === undefined))
  check('an unreadable replay is marked unknown', JSON.stringify(cpuOf(rows.junk)) === '[null,null]')
  check('games that already have cpu are untouched', JSON.stringify(cpuOf(rows.known)) === '[false,true]')
  const left = db.prepare(`SELECT COUNT(*) c FROM files WHERE instr(players, '"cpu":') = 0`).get().c
  check('only the missing replays are left', left === 2, String(left))

  // 3. The missing-replays check's column: games marked missing aren't tried.
  db.exec('ALTER TABLE files ADD COLUMN missing INTEGER NOT NULL DEFAULT 0')
  db.prepare('UPDATE files SET missing = 1 WHERE id IN (?, ?)').run(rows.missing, rows.goneFolder)
  const third = await scan(dbPath)
  check('games marked missing are skipped', third.total === 0, String(third.total))

  // 4. Game Filter: CPU games out by default, in with Include CPU games.
  const off = await filter(dbPath, { includeCpu: false }, total)
  check('Game Filter leaves the CPU game out by default', off.results === total - 2, `${off.results} of ${total}`)
  db.exec('DELETE FROM out')
  const on = await filter(dbPath, { includeCpu: true }, total)
  check('Include CPU games keeps it', on.results === total, `${on.results} of ${total}`)
  db.close()
  if (failed) {
    console.log(`${failed} check(s) failed`)
    process.exit(1)
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
