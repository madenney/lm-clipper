// Real-SQLite check: custom / AI Filter code that throws on a few games skips those
// games (counted as unreadable) instead of failing the run, and code that throws on
// EVERY game still fails. Run: scripts/worker-check/run.sh
const { Worker } = require('worker_threads')
const Database = require('better-sqlite3')
const fs = require('fs'), path = require('path')
const OUT = process.env.OUT
const WORKER = path.join(OUT, 'out/models/Worker.js')
const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
let failed = 0
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++ }
function run(dbPath, type, slice, params) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { dbPath, prevTableId: 'files', nextTableId: 'out', type, slice, params, skipSourceIds: [] } })
    const errors = []
    w.on('message', (m) => { if (m.type === 'error') errors.push(m.message); if (m.type === 'done') { resolve({ ...m, errors }); w.terminate() } })
    w.on('error', reject)
  })
}
function gamesDb(name, names) {
  const dir = path.join(OUT, name + '-replays'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir)
  const p = path.join(OUT, name); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  const db = new Database(p); db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT)')
  db.exec('CREATE TABLE "out" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = db.prepare('INSERT INTO files (path, players, winner, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, ?, 0, 31, 1, 3000, 0, ?)')
  for (const n of names) { const f = path.join(dir, n + '.slp'); fs.copyFileSync(REPLAY, f); ins.run(f, '[]', '') }
  return { db, p }
}
const names = ['good1', 'good2', 'bad1', 'good3', 'bad2', 'good4']
;(async () => {
  for (const type of ['custom', 'aiFilter']) {
    {
      const { db, p } = gamesDb(type + '-some.db', names)
      const code = "if (clips[0].path.includes('bad')) throw new Error(\"Cannot read properties of null (reading 'frame')\"); return clips"
      const r = await run(p, type, { bottom: 1, top: names.length }, { code, maxFiles: '' })
      const kept = db.prepare('SELECT COUNT(*) c FROM out').get().c
      check(type + ': games the code throws on are skipped, the rest are kept', kept === 4, String(kept))
      check(type + ': no run error for them', r.errors.length === 0, JSON.stringify(r.errors))
      check(type + ': they are counted as unreadable, with an example path', r.corrupt === 2 && r.examples.length === 2 && r.examples.every((e) => /bad\d/.test(e)), `corrupt=${r.corrupt} examples=${JSON.stringify(r.examples)}`)
      db.close()
    }
    {
      const { db, p } = gamesDb(type + '-all.db', names)
      const r = await run(p, type, { bottom: 1, top: names.length }, { code: "throw new Error('typo in my code')", maxFiles: '' })
      check(type + ': code that throws on every game still fails the run', r.errors.some((e) => /every game/.test(e) && /typo in my code/.test(e)), JSON.stringify(r.errors))
      db.close()
    }
    {
      const { db, p } = gamesDb(type + '-syntax.db', names)
      const r = await run(p, type, { bottom: 1, top: names.length }, { code: 'return (', maxFiles: '' })
      check(type + ': a syntax error still fails the run', r.errors.length > 0 && /Syntax error/.test(r.errors[0]), JSON.stringify(r.errors))
      db.close()
    }
  }
  console.log(failed ? failed + ' FAILED' : 'usercode: all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
