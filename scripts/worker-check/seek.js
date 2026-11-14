// Real-SQLite checks for the tray's window reads by position (src/main/rowSeek.ts)
// and the read lane (src/main/readLane.ts + DbReadWorker.ts): the same rows as the
// old LIMIT/OFFSET query (gaps, custom sorts with ties, the files table, writes from
// another connection), stopping, superseding, and how fast deep positions read.
// Run: scripts/worker-check/run.sh
const Database = require('better-sqlite3')
const fs = require('fs'), path = require('path')
const { Worker } = require('worker_threads')
const OUT = process.env.OUT
const { readWindow, WindowCache, STRIDE, seekSql } = require(path.join(OUT, 'out/main/rowSeek.js'))
const { ReadLane } = require(path.join(OUT, 'out/main/readLane.js'))
let failed = 0
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++ }
const fresh = (name) => { const p = path.join(OUT, name); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true }); return p }
const clip = (i) => JSON.stringify({ path: '/x/' + i + '.slp', stage: [2, 3, 8, 28, 31, 32][i % 6], startFrame: 100 + (i % 50), endFrame: 300,
  comboer: { characterId: i % 26, displayName: 'P' + (i % 100) }, comboee: { characterId: (i * 7) % 26 }, combo: { moves: [1, 2, 3].map((k) => ({ moveId: k, damage: k * 3.5 })) } })
const sortedIdx = (t) => `CREATE INDEX "idx_${t}_sortorder" ON "${t}"(COALESCE(sort_order, id), id)`
const orderOf = (db, t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(`idx_${t}_sortorder`) ? 'COALESCE(sort_order, id), id' : 'id'
// The query the tray used before (DbWorker handleGetItems).
const byOffset = (db, t, offset, limit) => db.prepare(`SELECT * FROM "${t}" ORDER BY ${orderOf(db, t)} LIMIT ? OFFSET ?`).all(limit, offset)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Every (offset, limit) pair in `offsets` x `limits` reads the same rows. */
function compare(name, writer, reader, cache, t, offsets, limits) {
  let bad = null, n = 0
  for (const o of offsets) for (const l of limits) {
    n += 1
    const want = byOffset(writer, t, o, l), got = readWindow(reader, cache, t, o, l)
    if (!same(want, got)) { bad = `offset ${o} limit ${l}: ${got && got.length} rows vs ${want.length}`; break }
  }
  check(name, !bad, bad || `${n} windows`)
}

{
  const p = fresh('seek.db')
  const w = new Database(p); w.pragma('journal_mode = WAL')
  w.exec('CREATE TABLE "g" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = w.prepare('INSERT INTO g (JSON) VALUES (?)')
  const N = 12_000
  w.transaction(() => { for (let i = 1; i <= N; i += 1) ins.run(clip(i)) })()
  // Gaps: a removed run, scattered removals, the first rows.
  w.exec('DELETE FROM g WHERE id BETWEEN 2000 AND 2600 OR id % 37 = 0 OR id <= 3')
  const total = w.prepare('SELECT COUNT(*) AS n FROM g').get().n
  const r = new Database(p, { readonly: true, fileMustExist: true })
  const cache = new WindowCache()
  const edges = [0, 1, STRIDE - 1, STRIDE, STRIDE + 1, 2 * STRIDE - 1, 5000, total - 2000, total - 1, total, total + 1, total + 5000]
  const rand = Array.from({ length: 40 }, (_, i) => Math.floor(((i * 2654435761) >>> 0) % (total + 100)))
  compare('ids with gaps: same rows as OFFSET', w, r, cache, 'g', [...edges, ...rand], [1, 7, 2000])

  // Custom sort with ties and NULLs (the tray's COALESCE(sort_order, id), id).
  w.exec(sortedIdx('g'))
  w.transaction(() => { for (let i = 1; i <= N; i += 3) w.prepare('UPDATE g SET sort_order = ? WHERE id = ?').run((i * 7919) % 400, i) })()
  compare('custom sort with ties: same rows as OFFSET', w, r, cache, 'g', [...edges, ...rand], [1, 7, 2000])
  // The statements rowSeek prepares for a sorted read must seek, not scan.
  const planOf = (sql) => r.prepare('EXPLAIN QUERY PLAN ' + sql).all({ k: 5, id: 5, skip: 3, limit: 10 }).map((x) => x.detail).join('; ')
  const sql = seekSql('g', true, true)
  const plan = planOf(sql.rows) + ' | ' + planOf(sql.keyAt)
  check('custom sort seeks on its index', /^SEARCH g USING INDEX idx_g_sortorder.* \| SEARCH g USING COVERING INDEX idx_g_sortorder/.test(plan), plan)

  // Writes from another connection (a filter run, a removal, a reorder) are seen.
  readWindow(r, cache, 'g', total - 10, 10) // index built to the end
  w.exec('DELETE FROM g WHERE id BETWEEN 5000 AND 5100')
  w.transaction(() => { for (let i = 0; i < 3000; i += 1) ins.run(clip(N + i)) })()
  w.prepare('UPDATE g SET sort_order = 1 WHERE id = ?').run(9000)
  const total2 = w.prepare('SELECT COUNT(*) AS n FROM g').get().n
  compare('after another connection writes: same rows as OFFSET', w, r, cache, 'g', [0, 4000, 4500, total2 - 2000, total2 - 1, total2], [1, 2000])

  // The files table (an unprocessed game filter reads it).
  w.exec('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT)')
  const fins = w.prepare('INSERT INTO files (path, players, stage) VALUES (?, ?, ?)')
  w.transaction(() => { for (let i = 0; i < 3000; i += 1) fins.run('/g/' + i + '.slp', '[]', i % 30) })()
  w.exec('DELETE FROM files WHERE id % 11 = 0')
  compare('files table: same rows as OFFSET', w, r, cache, 'files', [0, 999, 1024, 2500, 2726, 9999], [1, 200, 2000])

  // An empty table, a bad table id.
  w.exec('CREATE TABLE "e" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  check('empty table: no rows', same(readWindow(r, cache, 'e', 0, 2000), []) && same(readWindow(r, cache, 'e', 5000, 10), []))
  let threw = false
  try { readWindow(r, cache, 'g"; DROP TABLE g; --', 0, 10) } catch { threw = true }
  check('refuses a bad table id', threw)

  // Stopping keeps what it found; the next read goes on from there.
  const c2 = new WindowCache()
  let steps = 0
  const stopped = readWindow(r, c2, 'g', 10 * STRIDE, 5, () => ++steps > 4)
  check('a stopped read answers null', stopped === null, `after ${steps - 1} steps`)
  check('then reads on from where it stopped', same(readWindow(r, c2, 'g', 10 * STRIDE, 5), byOffset(w, 'g', 10 * STRIDE, 5)))
  r.close(); w.close()
}

// The read lane: DbReadWorker on its own read-only connection, superseding.
;(async () => {
  const p = fresh('lane.db')
  const w = new Database(p); w.pragma('journal_mode = WAL')
  w.exec('CREATE TABLE "big" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = w.prepare('INSERT INTO big (JSON) VALUES (?)')
  const N = 1_000_000
  w.transaction(() => { for (let i = 1; i <= N; i += 1) ins.run(clip(i)) })()

  const lane = new ReadLane((gens) => new Worker(path.join(OUT, 'out/main/DbReadWorker.js'), { workerData: { gens } }))
  const a = await lane.readWindow(p, 'big', 500, 50, 'tray')
  check('the worker reads a window', a.rows && same(a.rows, byOffset(w, 'big', 500, 50)))

  // A deep first read, superseded at once by a near one: the deep one stops.
  const deep = lane.readWindow(p, 'big', N - 100, 2000, 'tray')
  const near = lane.readWindow(p, 'big', 10, 5, 'tray')
  const other = lane.readWindow(p, 'big', 20, 5) // no lane: never superseded
  const [d, n, o] = await Promise.all([deep, near, other])
  check('a superseded read answers stale', d.stale === true, JSON.stringify(d).slice(0, 60))
  check('the newest read on the lane answers', n.rows && same(n.rows, byOffset(w, 'big', 10, 5)))
  check('reads without a lane are never superseded', o.rows && same(o.rows, byOffset(w, 'big', 20, 5)))

  // Reads while another connection writes in a long transaction (a filter run).
  w.exec('BEGIN IMMEDIATE'); ins.run(clip(0))
  const t0 = Date.now()
  const during = await lane.readWindow(p, 'big', 300_000, 20, 'tray')
  const duringMs = Date.now() - t0
  w.exec('COMMIT')
  check('reads while a write transaction is open', during.rows && during.rows.length === 20, `${duringMs} ms`)

  // Speed: the old OFFSET query vs the index (first visit walks once; then fast).
  const times = []
  for (const at of [100_000, 500_000, N - 2000]) {
    let t = process.hrtime.bigint(); byOffset(w, 'big', at, 2000); const off = Number(process.hrtime.bigint() - t) / 1e6
    t = process.hrtime.bigint(); const first = await lane.readWindow(p, 'big', at, 2000, 'tray'); const f = Number(process.hrtime.bigint() - t) / 1e6
    t = process.hrtime.bigint(); const again = await lane.readWindow(p, 'big', at - 3000, 2000, 'tray'); const g = Number(process.hrtime.bigint() - t) / 1e6
    times.push({ at, off, f, g, ok: same(first.rows, byOffset(w, 'big', at, 2000)) && same(again.rows, byOffset(w, 'big', at - 3000, 2000)) })
  }
  check('deep windows: right rows, later reads fast', times.every((x) => x.ok && x.g < x.off),
    times.map((x) => `@${x.at}: OFFSET ${x.off.toFixed(1)} ms, first ${x.f.toFixed(1)} ms, after ${x.g.toFixed(1)} ms`).join('; '))

  // The background lane's slow reads (dbAsync.ts): a table's length, a
  // selection's length and overview chunks, the same answers as on DbWorker.
  const { durationExpr, selectionFrames } = require(path.join(OUT, 'out/main/selectionSql.js'))
  const { readOverviewChunk, readOverviewSignature } = require(path.join(OUT, 'out/main/overview.js'))
  const { Selection } = require(path.join(OUT, 'out/lib/selection.js'))
  const cols = new Set(['id', 'JSON', 'sort_order'])
  const sumAll = w.prepare(`SELECT SUM(${durationExpr(cols)}) AS t FROM big`).get().t
  check('table length on the background lane', (await lane.query('tableDuration', { dbPath: p, tableId: 'big' })) === sumAll, `${sumAll} frames`)
  const sel = Selection.of(Array.from({ length: 5000 }, (_, i) => i * 7 + 3))
  const frames = await lane.query('selectionFrames', { dbPath: p, tableId: 'big', selection: sel.toWire() })
  const want = selectionFrames(w, 'big', sel, cols)
  check('selection length on the background lane', frames.frames === want.frames && frames.count === want.count, JSON.stringify(frames))
  check('overview fingerprint on the background lane', (await lane.query('overviewSignature', { dbPath: p, tableId: 'big' })) === readOverviewSignature(w, 'big'))
  const ch = await lane.query('overviewChunk', { dbPath: p, tableId: 'big', cursor: { key: 1000, id: 1000 }, limit: 500 })
  const wantCh = readOverviewChunk(w, 'big', { key: 1000, id: 1000 }, 500)
  check('overview chunk on the background lane', Buffer.from(ch.ids.buffer).equals(Buffer.from(wantCh.ids.buffer)) && Buffer.from(ch.packed).equals(Buffer.from(wantCh.packed)) && ch.next.id === wantCh.next.id)
  const s1 = lane.query('tableDuration', { dbPath: p, tableId: 'big' }, 'duration')
  const s2 = lane.query('tableDuration', { dbPath: p, tableId: 'big' }, 'duration')
  const [r1, r2] = await Promise.all([s1, s2])
  check('a newer length skips an older one not yet started', r1.stale === true && r2 === sumAll, JSON.stringify(r1))

  // Close lets go of the file (the project can be moved/compacted), then reopens.
  await lane.close()
  w.close()
  check('closing removes the WAL with the last connection', !fs.existsSync(p + '-wal'))
  const back = await lane.readWindow(p, 'big', 0, 3, 'tray')
  check('the next read opens it again', back.rows && back.rows.length === 3)
  let missing = null
  try { await lane.readWindow(fresh('nope.db'), 'big', 0, 3) } catch (e) { missing = e }
  check('a missing project is an error (never created)', missing && !fs.existsSync(path.join(OUT, 'nope.db')), missing && missing.message)
  lane.terminate()
  for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })

  console.log(failed ? `seek: ${failed} FAILED` : 'seek: all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
