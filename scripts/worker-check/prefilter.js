// Real-SQLite check for the Combo Filter's SQLite pre-check (Worker.ts
// comboPrefilter): same results as without it, progress reaches the total, and
// how much faster it is. Run: scripts/worker-check/run.sh
const { Worker } = require('worker_threads')
const Database = require('better-sqlite3')
const fs = require('fs'), path = require('path')
const OUT = process.env.OUT
const WORKER = path.join(OUT, 'out/models/Worker.js')
let failed = 0
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++ }
const NAMES = ['Jace', 'JACE', 'jace', 'Jacelyn', 'Mang0', 'Zain', 'Ñoño', 'ジェイス', 'Cody']
const player = (i, name, code) => ({ playerIndex: i, port: i + 1, characterId: 2, characterColor: 0, nametag: '', displayName: name, connectCode: code })
const clip = (i) => ({ path: '/x/' + i + '.slp', stage: 31, startFrame: 0, endFrame: 100,
  comboer: player(0, NAMES[i % NAMES.length], 'AB#' + (i % 50)), comboee: player(1, NAMES[(i * 7 + 3) % NAMES.length], 'CD#' + (i % 13)),
  combo: { startPercent: 0, endPercent: 50, didKill: i % 3 === 0, moves: Array.from({ length: 2 + (i % 6) }, (_, k) => ({ playerIndex: 0, frame: k, moveId: 10 + k, hitCount: 1, damage: 5 })) } })
const base = { minHits: '', maxHits: '', minDamage: '', comboerChar: [], comboerTag: [], comboerCC: [], comboeeChar: [], comboeeTag: [], comboeeCC: [], comboStage: [], didKill: false, countPummels: false, nthMoves: [] }

function run(db, next, params, noPrefilter) {
  return new Promise((resolve, reject) => {
    const n = db.prepare('SELECT COUNT(*) n FROM src').get().n
    db.exec(`DROP TABLE IF EXISTS "${next}"; CREATE TABLE "${next}" (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)`)
    const t0 = Date.now()
    let last = 0
    const w = new Worker(WORKER, { workerData: { dbPath: db.name, prevTableId: 'src', nextTableId: next, type: 'comboFilter', slice: { bottom: 1, top: n }, params, skipSourceIds: [] },
      env: { ...process.env, LUNAR_NO_PREFILTER: noPrefilter ? '1' : '0' } })
    w.on('message', (m) => { if (m.type === 'progress') last = m.current; if (m.type === 'done') { resolve({ ms: Date.now() - t0, last, n }); w.terminate() } })
    w.on('error', reject)
  })
}
const tags = (db, t) => db.prepare(`SELECT JSON FROM "${t}" ORDER BY id`).all().map((r) => JSON.parse(r.JSON).path).join('|')

;(async () => {
  const p = path.join(OUT, 'prefilter.db'); for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  const db = new Database(p); db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE src (id INTEGER PRIMARY KEY AUTOINCREMENT, JSON TEXT, sort_order INTEGER DEFAULT NULL)')
  const ins = db.prepare('INSERT INTO src (JSON) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 300_000; i += 1) ins.run(JSON.stringify(clip(i))) })()
  const cases = [
    ['tag Jace (any case), 5+ hits, kills', { ...base, comboerTag: ['jace'], minHits: '5', didKill: true }],
    ['tag typed as a string, two tags', { ...base, comboerTag: 'jace;zain' }],
    ['opponent tag + connect code', { ...base, comboeeTag: ['jacelyn'], comboerCC: ['ab#7'] }],
    ['a non-ASCII tag (pre-check skipped)', { ...base, comboerTag: ['ñoño'] }],
  ]
  for (const [name, params] of cases) {
    const a = await run(db, 'with', params, false)
    const b = await run(db, 'without', params, true)
    const same = tags(db, 'with') === tags(db, 'without')
    const count = db.prepare('SELECT COUNT(*) n FROM "with"').get().n
    check(`${name}: same results`, same && count > 0, `${count} clips; ${a.ms} ms with the pre-check vs ${b.ms} ms without`)
    check(`${name}: progress reaches the total`, a.last === a.n || a.last === 0, `${a.last}/${a.n}`)
  }
  // With player indexes (as a huge, fixed table can carry): exact lookups, same results.
  const expr = (f) => `lower(json_extract(JSON, '${f}'))`
  db.exec(`CREATE INDEX "idx_src_comboer_name" ON src(${expr('$.comboer.displayName')}, id)`)
  db.exec(`CREATE INDEX "idx_src_comboer_code" ON src(${expr('$.comboer.connectCode')}, id)`)
  const { comboPrefilter } = require(WORKER)
  const pf = comboPrefilter('comboFilter', 'src', { ...base, comboerTag: ['jace'] }, db)
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM src WHERE id >= 1 AND id <= 300000 AND ${pf.sql} ORDER BY id`).all(...pf.args).map((r) => r.detail).join(' / ')
  check('a player index is used when the table has one', pf.indexed === true && /idx_src_comboer_name/.test(plan), plan)
  for (const [name, params] of cases) {
    const a = await run(db, 'with', params, false)
    const b = await run(db, 'without', params, true)
    const same = tags(db, 'with') === tags(db, 'without')
    check(`indexed: ${name}: same results`, same, `${a.ms} ms indexed vs ${b.ms} ms without any pre-check`)
    check(`indexed: ${name}: progress reaches the total`, a.last === a.n || a.last === 0, `${a.last}/${a.n}`)
  }
  db.close()
  for (const f of [p, p + '-wal', p + '-shm']) fs.rmSync(f, { force: true })
  if (failed) { console.log(`${failed} failed`); process.exit(1) }
  console.log('prefilter: all passed')
})()
