// Real-SQLite checks for tray selections resolved in the DB worker
// (src/main/selectionSql.ts, src/lib/selection.ts): the same rows, order and sums as
// brute force (gaps, custom sorts with ties, Select All with rows left out), a wire
// that survives a worker's postMessage, and how long a big table takes.
// Run: scripts/worker-check/run.sh
const Database = require('better-sqlite3')
const fs = require('fs'), path = require('path')
const { Worker } = require('worker_threads')
const OUT = process.env.OUT
const { Selection } = require(path.join(OUT, 'out/lib/selection.js'))
const { selectionIds, selectionFrames } = require(path.join(OUT, 'out/main/selectionSql.js'))
const { RESULTS_TABLE_COLUMNS } = require(path.join(OUT, 'out/main/overview.js'))
let failed = 0
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++ }
const fresh = (name) => { const p = path.join(OUT, name); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true }); return p }
const SORTED = 'COALESCE(sort_order, id), id'
const frames = (j) => { const c = JSON.parse(j); const s = c.startFrame ?? 0; const e = (c.endFrame ?? 0) > 0 ? c.endFrame : (c.lastFrame ?? 0); return Math.max(0, e - s) }
let seed = 5
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }

{
  const db = new Database(fresh('sel.db'))
  db.exec(`CREATE TABLE "r" (${RESULTS_TABLE_COLUMNS})`)
  const ins = db.prepare('INSERT INTO r (JSON) VALUES (?)')
  const N = 20_000
  db.transaction(() => { for (let i = 1; i <= N; i += 1) ins.run(JSON.stringify(i % 7 ? { startFrame: i % 300, endFrame: 400 } : { lastFrame: 9000 + i })) })()
  db.exec('DELETE FROM r WHERE id % 89 = 0')
  // A custom sort with ties, like a manual reorder.
  db.exec('CREATE TABLE "s" AS SELECT id, JSON, (id * 37) % 500 AS sort_order FROM r')
  const rows = db.prepare('SELECT id, JSON FROM r').all()
  const cols = new Set(['id', 'JSON', 'sort_order'])
  const pick = (k) => Array.from({ length: k }, () => 1 + rand(N))
  const span = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  const sels = [
    ['one', Selection.of([12])],
    ['scattered', Selection.of(pick(9000))],
    ['runs + scattered', Selection.of([...span(10, 15000), ...pick(50)])],
    ['all', Selection.everything(N)],
    ['all but 40', Selection.everything(N).with(pick(40), false)],
    ['all but 18k', Selection.everything(N).with(span(1, 18000), false)],
  ]
  for (const [t, orderBy] of [['r', 'id'], ['s', SORTED]]) {
    const ordered = db.prepare(`SELECT id FROM "${t}" ORDER BY ${orderBy}`).all().map((x) => x.id)
    for (const [name, sel] of sels) {
      const want = ordered.filter((id) => sel.has(id))
      const got = Array.from(selectionIds(db, t, sel, orderBy))
      check(`ids in display order (${t}, ${name})`, JSON.stringify(got) === JSON.stringify(want), `${got.length} rows`)
    }
  }
  for (const [name, sel] of sels) {
    const picked = rows.filter((x) => sel.has(x.id))
    const want = { frames: picked.reduce((a, x) => a + frames(x.JSON), 0), count: picked.length }
    const got = selectionFrames(db, 'r', sel, cols)
    check(`frames and count (${name})`, got.frames === want.frames && got.count === want.count, JSON.stringify(got))
  }
  db.close()
}

// A selection's wire survives a worker's postMessage (main -> DbWorker).
{
  const sel = Selection.everything(1000).with([3, 70000, 5e6], false)
  const w = new Worker(`const { parentPort } = require('worker_threads'); parentPort.once('message', (m) => parentPort.postMessage(m))`, { eval: true })
  w.once('message', (m) => {
    const back = Selection.fromWire(m)
    check('wire through postMessage', back.all && back.count === 997 && !back.has(70000) && back.has(4), `${m.words.byteLength} bytes`)
    w.terminate()
    big()
  })
  w.postMessage(sel.toWire())
}

// How long a big table takes (informational).
function big() {
  const db = new Database(fresh('selbig.db'))
  db.exec(`CREATE TABLE "r" (${RESULTS_TABLE_COLUMNS})`)
  const N = 1_000_000
  const ins = db.prepare('INSERT INTO r (JSON) VALUES (?)')
  db.transaction(() => { for (let i = 1; i <= N; i += 1) ins.run(`{"startFrame":${i % 300},"endFrame":400}`) })()
  const cols = new Set(['id', 'JSON', 'sort_order'])
  const time = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [r, Number(process.hrtime.bigint() - t) / 1e6] }
  const out = Selection.everything(N).with(Array.from({ length: 1000 }, (_, i) => i * 997 + 1), false)
  const [ids, msIds] = time(() => selectionIds(db, 'r', out, 'id'))
  check('Select All but 1,000 of 1M: ids', ids.length === N - 1000, `${msIds.toFixed(0)} ms`)
  const [fr, msFr] = time(() => selectionFrames(db, 'r', out, cols))
  check('Select All but 1,000 of 1M: frames', fr.count === N - 1000, `${msFr.toFixed(0)} ms`)
  const range = Selection.of(new Uint32Array(300_000).map((_, i) => 200_001 + i))
  const [rf, msRange] = time(() => selectionFrames(db, 'r', range, cols))
  check('a 300k-row range: frames', rf.count === 300_000, `${msRange.toFixed(0)} ms`)
  const scattered = Selection.of(Array.from({ length: 50_000 }, (_, i) => 1 + i * 19))
  const [sf, msSc] = time(() => selectionFrames(db, 'r', scattered, cols))
  check('50k scattered rows: frames', sf.count === 50_000, `${msSc.toFixed(0)} ms`)
  db.close()
  console.log(failed ? `${failed} FAILED` : 'all selection checks passed')
  process.exit(failed ? 1 : 0)
}
