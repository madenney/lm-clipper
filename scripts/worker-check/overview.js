// Real-SQLite checks for the tray's overview reader (src/main/overview.ts):
// tray order with and without a custom sort, the files table, missing fields,
// and how fast it reads a big table. Run: scripts/worker-check/run.sh
const Database = require('better-sqlite3')
const fs = require('fs'), path = require('path')
const OUT = process.env.OUT
const { readOverviewChunk, OVERVIEW_NONE, OVERVIEW_STAGE_NONE, RESULTS_TABLE_COLUMNS, hasStoredOverview } = require(path.join(OUT, 'out/main/overview.js'))
let failed = 0
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++ }
const player = (i, c) => ({ playerIndex: i, port: i + 1, characterId: c, characterColor: 0, nametag: '', displayName: 'P' + i, connectCode: 'P#' + i })
const clip = (i) => ({ path: '/x/' + i + '.slp', stage: [2, 3, 8, 28, 31, 32][i % 6], startFrame: 100, endFrame: 200, comboer: player(0, i % 26), comboee: player(1, (i * 7) % 26),
  combo: { startPercent: 0, endPercent: 50, didKill: false, moves: [1, 2, 3, 4].map((k) => ({ playerIndex: 0, frame: 100 + k, moveId: 10 + k, hitCount: 1, damage: 10 })) } })
function readAll(db, t, limit) {
  const ids = [], bytes = []
  let cursor = null, chunks = 0
  do {
    const c = readOverviewChunk(db, t, cursor, limit)
    ids.push(...c.ids); bytes.push(...c.packed); cursor = c.next; chunks += 1
  } while (cursor)
  return { ids, bytes, chunks }
}

{
  const p = path.join(OUT, 'overview.db'); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  const db = new Database(p)
  db.exec('CREATE TABLE "t" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = db.prepare('INSERT INTO t (JSON) VALUES (?)')
  db.transaction(() => { for (let i = 1; i <= 25; i += 1) ins.run(JSON.stringify(clip(i))) })()
  // A row with no stage/characters (e.g. an odd filter's output).
  ins.run(JSON.stringify({ path: '/x/odd.slp' }))

  const plain = readAll(db, 't', 7)
  check('every row, in id order, across chunks', plain.ids.join() === Array.from({ length: 26 }, (_, i) => i + 1).join() && plain.chunks === 4, `${plain.chunks} chunks`)
  check('stage and both characters per row', plain.bytes.slice(0, 3).join() === [3, 1, 7].join(), plain.bytes.slice(0, 3).join())
  check('missing fields read as NONE', plain.bytes[75] === OVERVIEW_STAGE_NONE && plain.bytes.slice(76, 78).every((b) => b === OVERVIEW_NONE))

  // Custom sort (the tray's ORDER BY COALESCE(sort_order, id), id), like a reorder.
  db.exec('CREATE INDEX "idx_t_sortorder" ON "t"(COALESCE(sort_order, id), id)')
  db.prepare('UPDATE t SET sort_order = ? WHERE id = ?').run(0, 20)
  db.prepare('UPDATE t SET sort_order = ? WHERE id = ?').run(5, 3)
  const want = db.prepare('SELECT id FROM t ORDER BY COALESCE(sort_order, id), id').all().map((r) => r.id)
  const sorted = readAll(db, 't', 4)
  check('custom sort: same order as the tray', sorted.ids.join() === want.join(), sorted.ids.slice(0, 8).join())

  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT)')
  db.prepare('INSERT INTO files (path, players, stage) VALUES (?, ?, ?)').run('/x/g.slp', JSON.stringify([player(0, 20), player(1, 9)]), 31)
  const files = readAll(db, 'files', 10)
  check('files table: stage column, players JSON', files.bytes.join() === [31, 20, 9].join(), files.bytes.join())
  let threw = false
  try { readOverviewChunk(db, 't"; DROP TABLE t; --', null, 10) } catch { threw = true }
  check('refuses a bad table id', threw)
  db.close()
}

{
  // Speed: 1M realistic clip rows.
  const N = 1_000_000
  const p = path.join(OUT, 'overview-big.db'); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  const db = new Database(p); db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE "big" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = db.prepare('INSERT INTO big (JSON) VALUES (?)')
  let t0 = Date.now()
  db.transaction(() => { for (let i = 1; i <= N; i += 1) ins.run(JSON.stringify(clip(i))) })()
  const built = Date.now() - t0
  t0 = Date.now()
  let cursor = null, rows = 0, first = 0
  do {
    const c = readOverviewChunk(db, 'big', cursor, 250_000)
    if (!first) first = Date.now() - t0
    rows += c.ids.length; cursor = c.next
  } while (cursor)
  const ms = Date.now() - t0
  check(`reads ${N.toLocaleString()} rows`, rows === N, `${ms} ms total, first chunk ${first} ms, ${(N / ms * 1000 / 1e6).toFixed(2)}M rows/s (table built in ${built} ms)`)
  db.close()
  for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
}

{
  // Stored overview columns (results tables made since 2026-10-11): the same bytes
  // as the json_extract pass, read without parsing any JSON. 1M realistic rows each.
  const N = 1_000_000
  const p = path.join(OUT, 'overview-stored.db'); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  const db = new Database(p); db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE "legacy" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  db.exec(`CREATE TABLE "stored" (${RESULTS_TABLE_COLUMNS})`)
  const odd = [{ path: '/x/none.slp' }, { stage: '8', comboer: player(0, '20'), comboee: player(1, 2.0) },
    { stage: 2.5, comboer: player(0, -1), comboee: player(1, 300) }, { stage: 31, players: [player(0, 9), player(1, 20)] }]
  const times = {}
  for (const t of ['legacy', 'stored']) {
    const ins = db.prepare(`INSERT INTO "${t}" (JSON) VALUES (?)`)
    let t0 = Date.now()
    db.transaction(() => { for (let i = 1; i <= N; i += 1) ins.run(JSON.stringify(i <= odd.length ? odd[i - 1] : clip(i))) })()
    times[t] = { built: Date.now() - t0 }
  }
  check('stored columns only on the new table', hasStoredOverview(db, 'stored') && !hasStoredOverview(db, 'legacy'))
  const read = (t) => {
    const t0 = Date.now(); const ids = [], packed = []; let cursor = null
    do { const c = readOverviewChunk(db, t, cursor, 250_000); ids.push(c.ids); packed.push(c.packed); cursor = c.next } while (cursor)
    times[t].read = Date.now() - t0
    return { ids: Buffer.concat(ids.map((x) => Buffer.from(x.buffer))), packed: Buffer.concat(packed.map((x) => Buffer.from(x))) }
  }
  read('legacy'); read('stored') // warm both
  const a = read('legacy'), b = read('stored')
  check('stored columns: byte for byte the json_extract overview', a.ids.equals(b.ids) && a.packed.equals(b.packed) && b.ids.length === N * 4,
    `read ${times.legacy.read} ms -> ${times.stored.read} ms; insert ${times.legacy.built} ms -> ${times.stored.built} ms (${N.toLocaleString()} rows)`)
  db.close()
  for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
}

console.log(failed ? `overview: ${failed} failed so far` : 'overview: all passed')

// ── The on-disk cache (src/main/overviewCache.ts) ──
;(async () => {
  const cache = require(path.join(OUT, 'out/main/overviewCache.js'))
  const { readOverviewSignature } = require(path.join(OUT, 'out/main/overview.js'))
  const dir = path.join(OUT, 'cache'); fs.rmSync(dir, { recursive: true, force: true })
  cache.setOverviewCacheDir(dir)
  const p = path.join(OUT, 'cache.db'); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  const db = new Database(p); db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE "c" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = db.prepare('INSERT INTO c (JSON) VALUES (?)')
  const N = 600_000
  db.transaction(() => { for (let i = 1; i <= N; i += 1) ins.run(JSON.stringify(clip(i))) })()

  // A full read through the writer, like the controller does.
  const sig = readOverviewSignature(db, 'c')
  const w = new cache.OverviewCacheWriter('/proj/a.lunar', 'c', sig, N)
  const fromDb = { ids: [], packed: [] }
  let cursor = null
  let t0 = Date.now()
  do {
    const ch = readOverviewChunk(db, 'c', cursor, 250_000)
    check('each chunk follows on', w.follows(cursor))
    w.append(ch.ids, ch.packed, ch.next); fromDb.ids.push(ch.ids); fromDb.packed.push(ch.packed); cursor = ch.next
  } while (cursor)
  const dbMs = Date.now() - t0
  await w.finish()
  const meta = await cache.cachedOverview('/proj/a.lunar', 'c', sig, N)
  check('a cache with another row count misses', !(await cache.cachedOverview('/proj/a.lunar', 'c', sig, N - 1)))
  check('a full read is saved', meta && meta.count === N, JSON.stringify(meta))
  t0 = Date.now()
  const a = await cache.readCachedChunk('/proj/a.lunar', 'c', 0, 1_000_000, N)
  const cacheMs = Date.now() - t0
  const joined = (parts) => { const out = new parts[0].constructor(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length } return out }
  const ids = joined(fromDb.ids), packed = joined(fromDb.packed)
  check('reads back byte for byte', Buffer.compare(Buffer.from(a.ids.buffer), Buffer.from(ids.buffer)) === 0 && Buffer.compare(Buffer.from(a.packed), Buffer.from(packed)) === 0)
  check('reading the cache is faster than SQLite', cacheMs < dbMs, `cache ${cacheMs} ms vs SQLite ${dbMs} ms for ${N.toLocaleString()} rows`)
  const mid = await cache.readCachedChunk('/proj/a.lunar', 'c', 300_000, 10, N)
  check('reads from the middle', mid.ids[0] === ids[300_000] && mid.ids.length === 10)
  check('other projects and filters miss', !(await cache.cachedOverview('/proj/b.lunar', 'c', sig, N)) && !(await cache.cachedOverview('/proj/a.lunar', 'd', sig, N)))

  // The fingerprint follows the table.
  ins.run(JSON.stringify(clip(1)))
  const sig2 = readOverviewSignature(db, 'c')
  check('an added row changes the fingerprint (cache missed)', sig2 !== sig && !(await cache.cachedOverview('/proj/a.lunar', 'c', sig2, N + 1)))
  db.prepare('DELETE FROM c WHERE id = ?').run(N + 1)
  check('removing it again matches', readOverviewSignature(db, 'c') === sig)
  db.prepare('DELETE FROM c WHERE id = 1').run()
  check('a removed first row changes it', readOverviewSignature(db, 'c') !== sig)
  db.exec('DROP TABLE c'); db.exec('CREATE TABLE "c" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  db.transaction(() => { for (let i = 1; i <= 10; i += 1) ins.run(JSON.stringify({ ...clip(i), stage: 99 })) })()
  check('a re-run (new contents) changes it', readOverviewSignature(db, 'c') !== sig)

  await cache.invalidateOverview('/proj/a.lunar', 'c')
  check('a reorder forgets it', !(await cache.cachedOverview('/proj/a.lunar', 'c', sig, N)))

  // Removals cascade across filters: one call forgets the whole project.
  for (const f of ['p1', 'p2']) {
    const wr = new cache.OverviewCacheWriter('/proj/a.lunar', f, 'sig', cache.CACHE_MIN_ROWS)
    wr.append(new Uint32Array(cache.CACHE_MIN_ROWS), new Uint8Array(cache.CACHE_MIN_ROWS * 3), null); await wr.finish()
  }
  const keep = new cache.OverviewCacheWriter('/proj/b.lunar', 'p1', 'sig', cache.CACHE_MIN_ROWS)
  keep.append(new Uint32Array(cache.CACHE_MIN_ROWS), new Uint8Array(cache.CACHE_MIN_ROWS * 3), null); await keep.finish()
  await cache.invalidateProjectOverviews('/proj/a.lunar')
  check('a removal forgets the whole project, not others', !(await cache.cachedOverview('/proj/a.lunar', 'p1', 'sig', cache.CACHE_MIN_ROWS)) && !(await cache.cachedOverview('/proj/a.lunar', 'p2', 'sig', cache.CACHE_MIN_ROWS)) && !!(await cache.cachedOverview('/proj/b.lunar', 'p1', 'sig', cache.CACHE_MIN_ROWS)))

  // A read that saved more (or fewer) rows than the table has is never kept: a
  // chunk asked for twice, or a stale read appending to a newer one.
  const twice = new cache.OverviewCacheWriter('/proj/a.lunar', 't', 'sig', cache.CACHE_MIN_ROWS)
  twice.append(new Uint32Array(cache.CACHE_MIN_ROWS), new Uint8Array(cache.CACHE_MIN_ROWS * 3), { key: 9, id: 9 })
  check('a repeated cursor does not follow on', !twice.follows(null) && twice.follows({ key: 9, id: 9 }))
  twice.append(new Uint32Array(10), new Uint8Array(30), null); await twice.finish()
  check('extra rows are not saved', !(await cache.cachedOverview('/proj/a.lunar', 't', 'sig', cache.CACHE_MIN_ROWS)) && !(await cache.cachedOverview('/proj/a.lunar', 't', 'sig', cache.CACHE_MIN_ROWS + 10)))

  const small = new cache.OverviewCacheWriter('/proj/a.lunar', 's', 'x', 2)
  small.append(new Uint32Array([1, 2]), new Uint8Array(6), null); await small.finish()
  check('small tables are not cached', !(await cache.cachedOverview('/proj/a.lunar', 's', 'x', 2)) && fs.readdirSync(dir).every((f) => !f.includes('-s.')))
  db.close()
  for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  if (failed) { console.log(`${failed} failed`); process.exit(1) }
  console.log('overview cache: all passed')
})()
