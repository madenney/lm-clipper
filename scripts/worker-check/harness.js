// Real-SQLite checks for the filter worker (src/models/Worker.ts), which Jest
// can't run: better-sqlite3 is built for Electron. Covers id gaps after
// removals, manual order carried downstream, Combo Parser resume, and the
// combo cache (same results; a warm run never opens the replays).
// Run: scripts/worker-check/run.sh
const { Worker } = require('worker_threads')
const Database = require('better-sqlite3')
const fs = require('fs'), path = require('path')
// Built by run.sh into OUT (a temp dir); test databases go there too.
const OUT = process.env.OUT
const WORKER = path.join(OUT, 'out/models/Worker.js')
const REPLAY = path.resolve(__dirname, '../../assets/test.slp')
let failed = 0
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++ }
function run(dbPath, prevTableId, nextTableId, type, slice, params, skipSourceIds = [], extra = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { dbPath, prevTableId, nextTableId, type, slice, params, skipSourceIds, ...extra } })
    const errors = [], progress = []
    w.on('message', (m) => { if (m.type === 'error') errors.push(m.message); if (m.type === 'progress') progress.push(m.current); if (m.type === 'done') { resolve({ ...m, errors, progress }); w.terminate() } })
    w.on('error', reject)
  })
}
function freshDb(name) {
  const p = path.join(OUT, name); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  const db = new Database(p); db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, players TEXT, winner INTEGER, stage INTEGER, startedAt INTEGER, lastFrame INTEGER, isProcessed INTEGER, info TEXT)')
  for (const t of ['src', 'out', 'out2']) db.exec('CREATE TABLE "' + t + '" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  return { db, p }
}
const player = (i) => ({ playerIndex: i, port: i + 1, characterId: 2, characterColor: 0, nametag: '', displayName: 'P' + i, connectCode: 'P#' + i })
const clip = (tag) => ({ tag, path: REPLAY, stage: 31, startFrame: 100, endFrame: 200, comboer: player(0), comboee: player(1), combo: { startPercent: 0, endPercent: 50, didKill: false, moves: [1,2,3].map((k) => ({ playerIndex: 0, frame: 100 + k, moveId: 10 + k, hitCount: 1, damage: 10 })) } })
const passAll = { minHits: '', maxHits: '', minDamage: '', comboerChar: [], comboerTag: [], comboerCC: [], comboeeChar: [], comboeeTag: [], comboeeCC: [], comboStage: [], didKill: false, countPummels: false, nthMoves: [] }
const tags = (db, t, order) => db.prepare('SELECT JSON FROM "' + t + '" ORDER BY ' + order).all().map((r) => JSON.parse(r.JSON).tag)

;(async () => {
  // 1. Rows after a removal are not skipped.
  {
    const { db, p } = freshDb('gap.db')
    const ins = db.prepare('INSERT INTO src (JSON) VALUES (?)')
    for (let i = 1; i <= 10; i++) ins.run(JSON.stringify(clip('c' + i)))
    db.prepare('DELETE FROM src WHERE id IN (3, 7)').run()
    const n = db.prepare('SELECT COUNT(*) c FROM src').get().c
    const r1 = await run(p, 'src', 'out', 'comboFilter', { bottom: 1, top: n }, passAll)
    const got = tags(db, 'out', 'id')
    check('one worker keeps every row after removals', got.length === 8 && got.includes('c10') && got.includes('c9'), JSON.stringify(got))
    const [a, b] = await Promise.all([run(p, 'src', 'out2', 'comboFilter', { bottom: 1, top: 4 }, passAll), run(p, 'src', 'out2', 'comboFilter', { bottom: 5, top: n }, passAll)])
    const got2 = tags(db, 'out2', 'id').sort()
    check('two workers split by position cover every row once', got2.length === 8 && new Set(got2).size === 8 && got2.includes('c10'), JSON.stringify(got2))
    const r3 = await run(p, 'src', 'out', 'randomSample', { bottom: 1, top: n }, { count: '' })
    check('random sample (keep all) after removals', r3.results === 8, String(r3.results))
    db.close()
  }
  // 2. A manually reordered input keeps its order downstream.
  {
    const { db, p } = freshDb('order.db')
    const ins = db.prepare('INSERT INTO src (JSON) VALUES (?)')
    for (let i = 1; i <= 6; i++) ins.run(JSON.stringify(clip('c' + i)))
    // The user dragged the clips into reverse order (as updateSortOrder does).
    const up = db.prepare('UPDATE src SET sort_order = ? WHERE id = ?')
    for (let i = 1; i <= 6; i++) up.run(100 - i, i)
    db.exec('CREATE INDEX "idx_src_sortorder" ON src(COALESCE(sort_order, id), id)')
    const shown = tags(db, 'src', 'COALESCE(sort_order, id), id')
    await run(p, 'src', 'out', 'comboFilter', { bottom: 1, top: 6 }, passAll)
    const marked = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_out_sortorder'").get()
    const after = tags(db, 'out', 'COALESCE(sort_order, id), id')
    check('next filter shows clips in the dragged order', JSON.stringify(after) === JSON.stringify(shown) && marked, JSON.stringify(after))
    // and the order carries one more step
    await run(p, 'out', 'out2', 'comboFilter', { bottom: 1, top: 6 }, passAll)
    check('...and the filter after that', JSON.stringify(tags(db, 'out2', 'COALESCE(sort_order, id), id')) === JSON.stringify(shown))
    // without a manual order nothing changes
    const { db: db2, p: p2 } = freshDb('plain.db')
    for (let i = 1; i <= 3; i++) db2.prepare('INSERT INTO src (JSON) VALUES (?)').run(JSON.stringify(clip('c' + i)))
    await run(p2, 'src', 'out', 'comboFilter', { bottom: 1, top: 3 }, passAll)
    const plain = db2.prepare('SELECT COUNT(*) c FROM out WHERE sort_order IS NOT NULL').get().c
    const idx = db2.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_out_sortorder'").get()
    check('unordered input: no sort_order, no index', plain === 0 && !idx)
    db.close(); db2.close()
  }
  // 3. Resuming the Combo Parser doesn't duplicate combos.
  {
    const { db, p } = freshDb('resume.db')
    const ins = db.prepare('INSERT INTO files (path, players, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, ?, 31, 0, 1000, 0, ?)')
    for (let i = 0; i < 3; i++) ins.run(REPLAY, JSON.stringify([player(0), player(1)]), '')
    const params = { minHits: '2', maxHits: '', maxFiles: '', comboTimeout: '', comboerChar: [], comboeeChar: [], comboerTag: [], comboerCC: [], comboeeTag: [], comboeeCC: [], didKill: false }
    // "Stopped" after the first game: parse only position 1.
    const first = await run(p, 'files', 'out', 'slpParser', { bottom: 1, top: 1 }, params)
    const rows = db.prepare('SELECT JSON FROM out').all().map((r) => JSON.parse(r.JSON))
    check('parser rows record their game', rows.length > 0 && rows.every((r) => r._sourceId === 1), rows.length + ' combos, errors ' + JSON.stringify(first.errors.slice(0, 1)))
    // Resume over all three: the getProcessedSourceIds query, then a run that skips them.
    const done = db.prepare("SELECT DISTINCT CAST(JSON_EXTRACT(JSON, '$._sourceId') AS INTEGER) AS sid FROM out WHERE JSON_EXTRACT(JSON, '$._sourceId') IS NOT NULL").all().map((r) => r.sid)
    await run(p, 'files', 'out', 'slpParser', { bottom: 1, top: 3 }, params, done)
    const per = db.prepare("SELECT JSON_EXTRACT(JSON, '$._sourceId') sid, COUNT(*) c FROM out GROUP BY sid").all()
    check('resume adds games 2 and 3 once, game 1 not again', per.length === 3 && per.every((x) => x.c === rows.length), JSON.stringify(per))
    db.close()
  }
  // 4. The combo cache: same results, and a warm run doesn't read the replays.
  {
    const { db, p } = freshDb('cache.db')
    const lib = path.join(OUT, 'CacheLibrary')
    fs.rmSync(lib, { recursive: true, force: true })
    const copies = [1, 2, 3].map((i) => path.join(OUT, 'cache-' + i + '.slp'))
    for (const c of copies) fs.copyFileSync(REPLAY, c)
    const ins = db.prepare('INSERT INTO files (path, players, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, ?, 31, 0, 1000, 0, ?)')
    for (const c of copies) ins.run(c, JSON.stringify([player(0), player(1)]), '')
    db.exec('CREATE TABLE "c1" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER)')
    db.exec('CREATE TABLE "c2" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER)')
    db.exec('CREATE TABLE "c3" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER)')
    db.exec('CREATE TABLE "c4" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER)')
    const params = { minHits: '2', maxHits: '', maxFiles: '', comboTimeout: '', comboerChar: [], comboeeChar: [], comboerTag: [], comboerCC: [], comboeeTag: [], comboeeCC: [], didKill: false }
    const rows = (t) => db.prepare('SELECT JSON FROM "' + t + '" ORDER BY id').all().map((r) => r.JSON)
    await run(p, 'files', 'out', 'slpParser', { bottom: 1, top: 3 }, params)
    await run(p, 'files', 'c1', 'slpParser', { bottom: 1, top: 3 }, params, [], { libraryFolder: lib })
    check('cold cache run: same combos as no cache', JSON.stringify(rows('c1')) === JSON.stringify(rows('out')) && rows('out').length > 0, rows('out').length + ' combos')
    for (const c of copies) fs.chmodSync(c, 0o000)
    try {
      const warm = await run(p, 'files', 'c2', 'slpParser', { bottom: 1, top: 3 }, params, [], { libraryFolder: lib })
      check('warm cache run: same combos without reading the replays', JSON.stringify(rows('c2')) === JSON.stringify(rows('out')) && !warm.corrupt && !warm.missing)
      const fewer = await run(p, 'files', 'c3', 'slpParser', { bottom: 1, top: 3 }, { ...params, minHits: '5' }, [], { libraryFolder: lib })
      const expect5 = rows('out').filter((j) => JSON.parse(j).combo.moves.length >= 5).length
      check('other filter settings reuse the cache', rows('c3').length === expect5 && expect5 > 0 && !fewer.corrupt, rows('c3').length + ' combos with 5+ moves')
      // A different combo timeout changes detection: it must read the file (here: can't).
      const other = await run(p, 'files', 'c4', 'slpParser', { bottom: 1, top: 3 }, { ...params, comboTimeout: '60' }, [], { libraryFolder: lib })
      check('a different combo timeout is not served from the cache', other.corrupt === 3)
    } finally {
      for (const c of copies) fs.chmodSync(c, 0o644)
    }
    const ldb = new Database(path.join(lib, 'library.sqlite'), { readonly: true })
    const md5 = require('crypto').createHash('md5').update(fs.readFileSync(REPLAY)).digest('hex')
    const games = ldb.prepare('SELECT COUNT(*) c FROM games WHERE contentHash = ?').get(md5).c
    const linked = ldb.prepare('SELECT COUNT(*) c FROM paths p JOIN games g ON g.id = p.gameId WHERE g.contentHash = ?').get(md5).c
    check('three copies of one recording are one game (MD5 of the .slp)', games === 1 && linked === 3)
    ldb.close(); db.close()
  }

  // 5. The edgeguard cache (files mode): same clips, warm run without reading.
  {
    const { db, p } = freshDb('egcache.db')
    const lib = path.join(OUT, 'EgLibrary')
    fs.rmSync(lib, { recursive: true, force: true })
    const src = process.env.EDGEGUARD_REPLAY || REPLAY
    const copies = [1, 2].map((i) => path.join(OUT, 'eg-' + i + '.slp'))
    for (const c of copies) fs.copyFileSync(src, c)
    const game = require(path.join(OUT, 'out/models/File.js')).fileProcessor(src)
    const ins = db.prepare('INSERT INTO files (path, players, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, ?, ?, 0, 1000, 0, ?)')
    for (const c of copies) ins.run(c, JSON.stringify(game.players), game.stage, '')
    for (const t of ['e0', 'e1', 'e2']) db.exec('CREATE TABLE "' + t + '" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER)')
    const params = { comboerChar: [], comboeeChar: [], comboerTag: [], comboeeTag: [], comboerCC: [], comboeeCC: [], stageFilter: [] }
    const rows = (t) => db.prepare('SELECT JSON FROM "' + t + '" ORDER BY id').all().map((r) => r.JSON)
    await run(p, 'files', 'e0', 'edgeguard', { bottom: 1, top: 2 }, params)
    await run(p, 'files', 'e1', 'edgeguard', { bottom: 1, top: 2 }, params, [], { libraryFolder: lib })
    check('edgeguard cache, cold: same clips as no cache', JSON.stringify(rows('e1')) === JSON.stringify(rows('e0')), rows('e0').length + ' edgeguards')
    for (const c of copies) fs.chmodSync(c, 0o000)
    try {
      await run(p, 'files', 'e2', 'edgeguard', { bottom: 1, top: 2 }, params, [], { libraryFolder: lib })
      check('edgeguard cache, warm: same clips without reading the replays', JSON.stringify(rows('e2')) === JSON.stringify(rows('e0')))
    } finally {
      for (const c of copies) fs.chmodSync(c, 0o644)
    }
    db.close()
  }

  // 5b. Replays kept as .slpz (lib/slpz.ts): the parsers, the edgeguard finder
  // and custom code read them in memory with the same results as the .slp,
  // and the detector cache knows a .slpz as the same game as its .slp.
  {
    const { encodeSlpz } = require(path.join(OUT, 'out/lib/slpz.js'))
    const { db, p } = freshDb('slpz.db')
    const lib = path.join(OUT, 'SlpzLibrary')
    fs.rmSync(lib, { recursive: true, force: true })
    const src = process.env.EDGEGUARD_REPLAY || REPLAY
    const slpCopy = path.join(OUT, 'kept.slp')
    const slpzCopy = path.join(OUT, 'kept.slpz')
    fs.copyFileSync(src, slpCopy)
    fs.writeFileSync(slpzCopy, encodeSlpz(fs.readFileSync(src)))
    const { fileProcessor } = require(path.join(OUT, 'out/models/File.js'))
    const hz = fileProcessor(slpzCopy)
    const hs = fileProcessor(slpCopy)
    check('.slpz: import reads the same header', JSON.stringify({ ...hz, path: '' }) === JSON.stringify({ ...hs, path: '' }) && hz.isValid)
    const ins = db.prepare('INSERT INTO files (path, players, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, ?, ?, 0, ?, 0, ?)')
    ins.run(slpCopy, JSON.stringify(hs.players), hs.stage, hs.lastFrame, '')
    ins.run(slpzCopy, JSON.stringify(hz.players), hz.stage, hz.lastFrame, '')
    for (const t of ['z1', 'z2', 'z3', 'z4']) db.exec('CREATE TABLE "' + t + '" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER)')
    const params = { minHits: '2', maxHits: '', maxFiles: '', comboTimeout: '', comboerChar: [], comboeeChar: [], comboerTag: [], comboerCC: [], comboeeTag: [], comboeeCC: [], didKill: false }
    const byGame = (t) => {
      const out = { 1: [], 2: [] }
      for (const r of db.prepare('SELECT JSON FROM "' + t + '" ORDER BY id').all()) {
        const j = JSON.parse(r.JSON)
        out[j._sourceId].push(JSON.stringify({ ...j, path: '', _sourceId: 0 }))
      }
      return out
    }
    const r1 = await run(p, 'files', 'z1', 'slpParser', { bottom: 1, top: 2 }, params, [], { libraryFolder: lib })
    const c = byGame('z1')
    check('.slpz: Combo Parser finds the same combos', c[1].length > 0 && JSON.stringify(c[1]) === JSON.stringify(c[2]) && !r1.corrupt, c[1].length + ' vs ' + c[2].length)
    const egParams = { comboerChar: [], comboeeChar: [], comboerTag: [], comboeeTag: [], comboerCC: [], comboeeCC: [], stageFilter: [] }
    await run(p, 'files', 'z2', 'edgeguard', { bottom: 1, top: 2 }, egParams, [], { libraryFolder: lib })
    const e = byGame('z2')
    check('.slpz: edgeguards are the same', JSON.stringify(e[1]) === JSON.stringify(e[2]), e[1].length + ' vs ' + e[2].length)
    const code = 'return clips.map(g => { const f = new SlippiGame(g.path).getFrames(); return { path: g.path, stage: g.stage, startFrame: 0, endFrame: Object.keys(f).length } })'
    await run(p, 'files', 'z3', 'custom', { bottom: 1, top: 2 }, { code, maxFiles: '' })
    const u = byGame('z3')
    check('.slpz: custom code\'s SlippiGame opens it', u[1].length === 1 && JSON.stringify(u[1]) === JSON.stringify(u[2]), JSON.stringify([u[1], u[2]]).slice(0, 200))
    const ldb = new Database(path.join(lib, 'library.sqlite'), { readonly: true })
    const md5 = require('crypto').createHash('md5').update(fs.readFileSync(src)).digest('hex')
    const linked = ldb.prepare('SELECT COUNT(DISTINCT p.path) c, COUNT(DISTINCT g.id) g FROM paths p JOIN games g ON g.id = p.gameId WHERE g.contentHash = ?').get(md5)
    check('.slpz: one game with its .slp in the detector cache (MD5 of the decoded .slp)', linked.c === 2 && linked.g === 1, JSON.stringify(linked))
    ldb.close()
    // Warm: neither file is read again.
    for (const f of [slpCopy, slpzCopy]) fs.chmodSync(f, 0o000)
    try {
      const warm = await run(p, 'files', 'z4', 'slpParser', { bottom: 1, top: 2 }, params, [], { libraryFolder: lib })
      const w = byGame('z4')
      check('.slpz: a warm run reuses the cache', !warm.corrupt && JSON.stringify(w[2]) === JSON.stringify(c[2]))
    } finally {
      for (const f of [slpCopy, slpzCopy]) fs.chmodSync(f, 0o644)
    }
    db.close()
  }

  // 6. Custom Code / AI Filter: small batches, progress per game, clean resume.
  {
    const { db, p } = freshDb('usercode.db')
    const ins = db.prepare('INSERT INTO files (path, players, stage, startedAt, lastFrame, isProcessed, info) VALUES (?, ?, 31, 0, 1000, 0, ?)')
    for (let i = 0; i < 6; i++) ins.run(REPLAY, JSON.stringify([player(0), player(1)]), '')
    // Code that builds NEW clip objects per game (as AI answers do).
    const perGame = 'return clips.map(g => ({ path: g.path, stage: g.stage, startFrame: 0, endFrame: 60 }))'
    const r = await run(p, 'files', 'out', 'aiFilter', { bottom: 1, top: 6 }, { code: perGame, maxFiles: '' })
    const ticks = new Set(r.progress)
    check('AI Filter on games ticks +1 per game', [1, 2, 3, 4, 5, 6].every((n) => ticks.has(n)), JSON.stringify(r.progress))
    const sids = db.prepare("SELECT JSON_EXTRACT(JSON, '$._sourceId') sid FROM out ORDER BY id").all().map((x) => x.sid)
    check('...and tags each new clip with its game (for resume)', sids.length === 6 && sids.every((x, i) => x === i + 1), JSON.stringify(sids))

    // Clips input: batches of 25, progress after each.
    const insClip = db.prepare('INSERT INTO src (JSON) VALUES (?)')
    for (let i = 1; i <= 60; i++) insClip.run(JSON.stringify(clip('c' + i)))
    const keepAll = 'return clips'
    const r2 = await run(p, 'src', 'out2', 'custom', { bottom: 1, top: 60 }, { code: keepAll, maxFiles: '' })
    check('Custom Code on clips reports progress per batch of 25', r2.progress.includes(25) && r2.progress.includes(50) && r2.progress.includes(60) && r2.results === 60, JSON.stringify(r2.progress))

    // Resume: stopped after 30 clips; resuming the whole input skips exactly
    // those with results (keeping only odd tags = some items gave no result).
    db.exec('DELETE FROM out2')
    const odd = "return clips.filter(c => Number(c.tag.slice(1)) % 2 === 1)"
    await run(p, 'src', 'out2', 'custom', { bottom: 1, top: 30 }, { code: odd, maxFiles: '' })
    const done = db.prepare("SELECT DISTINCT CAST(JSON_EXTRACT(JSON, '$._sourceId') AS INTEGER) AS sid FROM out2").all().map((x) => x.sid)
    await run(p, 'src', 'out2', 'custom', { bottom: 1, top: 60 }, { code: odd, maxFiles: '' }, done)
    const got = tags(db, 'out2', 'id')
    check('resume in batches: every odd clip exactly once, none lost', got.length === 30 && new Set(got).size === 30 && got.includes('c59') && got.includes('c1'), got.length + ' rows')
    db.close()
  }

  // 7. Results tables with the tray's stored overview columns (main/overview.ts):
  // every way the worker writes rows fills them, equal to the JSON's fields.
  {
    const { RESULTS_TABLE_COLUMNS, readOverviewChunk } = require(path.join(OUT, 'out/main/overview.js'))
    const { db, p } = freshDb('stored.db')
    const ins = db.prepare('INSERT INTO src (JSON) VALUES (?)')
    for (let i = 1; i <= 12; i++) ins.run(JSON.stringify({ ...clip('c' + i), stage: [2, 3, 8, 31][i % 4], comboer: { ...player(0), characterId: i } }))
    const fresh = (t) => { db.exec(`DROP TABLE IF EXISTS "${t}"`); db.exec(`CREATE TABLE "${t}" (${RESULTS_TABLE_COLUMNS})`) }
    const mismatched = (t) => db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE ov_stage IS NOT json_extract(JSON, '$.stage')
      OR ov_char1 IS NOT json_extract(JSON, '$.comboer.characterId') OR ov_char2 IS NOT json_extract(JSON, '$.comboee.characterId')`).get().c
    const runs = [
      ['comboFilter', passAll], ['sort', { sortFunction: 'stage', reverse: false }], ['randomSample', { count: '5' }],
      ['randomSample', { count: '' }], ['range', { from: '3', to: '9' }],
    ]
    for (const [type, params] of runs) {
      fresh('out')
      const r = await run(p, 'src', 'out', type, { bottom: 1, top: 12 }, params)
      const n = db.prepare('SELECT COUNT(*) c FROM out').get().c
      check(`stored overview columns filled by ${type}`, n > 0 && n === r.results && mismatched('out') === 0, `${n} rows, ${mismatched('out')} wrong ${JSON.stringify(r.errors.slice(0, 1))}`)
    }
    // A manually ordered input: rows written with their sort_order too.
    const up = db.prepare('UPDATE src SET sort_order = ? WHERE id = ?')
    for (let i = 1; i <= 12; i++) up.run(100 - i, i)
    db.exec('CREATE INDEX "idx_src_sortorder" ON src(COALESCE(sort_order, id), id)')
    fresh('out')
    await run(p, 'src', 'out', 'comboFilter', { bottom: 1, top: 12 }, passAll)
    const ov = readOverviewChunk(db, 'out', null, 100)
    check('...and by a manually ordered run, read in tray order', mismatched('out') === 0 && ov.ids.length === 12 && ov.packed[1] === 12, `first char ${ov.packed[1]}`)
    db.close()
  }

  console.log(failed ? failed + ' FAILED' : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
