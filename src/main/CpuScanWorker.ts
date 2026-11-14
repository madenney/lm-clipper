/**
 * Finds CPU players in games imported before Clipper recorded them
 * (lib/cpuPlayers.ts): reads the first bytes of each replay whose files row has
 * no `cpu` on its players yet and writes it in. Low priority and resumable: a
 * batch at a time with a rest after each one (at most about half the time spent
 * reading), so a project of millions of games on a network share isn't
 * hammered; rows already done are simply not picked again, so the next open
 * continues where this one stopped. The main process (controller.ts) starts it
 * after the missing-replays check and pauses it while an import or filter runs.
 *
 * workerData: { dbPath, batchSize?, restMs? }
 * In:  { type: 'pause' } | { type: 'resume' } | { type: 'stop' }
 * Out: { type: 'progress' | 'done', ...CpuScanCounts } | { type: 'error', message }
 *
 * Missing replays are passed over (left unknown, tried again next time); a
 * replay that opens but isn't a readable .slp gets cpu: null (unknown for good).
 */
import { parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {
  type CpuScanCounts,
  HEADER_BYTES,
  isCpuGame,
  playerTypesFromHeader,
  withCpu,
} from '../lib/cpuPlayers'
import {
  isSlpzPath,
  looksLikeSlp,
  readSlpzHead,
  slpzSlpPrefix,
} from '../lib/slpz'

const {
  dbPath,
  batchSize = 200,
  restMs = 250,
} = workerData as { dbPath: string; batchSize?: number; restMs?: number }

// Rows whose players were never checked: players is a JSON array and none of
// them has a "cpu" key (written by JSON.stringify, so the text is exact).
const PENDING = `players LIKE '[{%' AND instr(players, '"cpu":') = 0`
// This many replays in a row out of reach (with nothing found): the drive or
// share is gone. Stop for now instead of trying every one.
const GIVE_UP_AFTER = 2000

let paused = false
let stopped = false
parentPort?.on('message', (m: { type?: string }) => {
  if (m?.type === 'pause') paused = true
  else if (m?.type === 'resume') paused = false
  else if (m?.type === 'stop') stopped = true
})

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Folders known to be gone this run: their replays aren't tried one by one. */
const goneFolders = new Set<string>()

/** The first bytes of a replay, or 'missing' when it can't be opened. */
function readHeader(file: string): Uint8Array | 'missing' {
  const dir = path.dirname(file)
  if (goneFolders.has(dir)) return 'missing'
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' &&
      !fs.existsSync(dir)
    )
      goneFolders.add(dir)
    return 'missing'
  }
  try {
    // A .slpz keeps its Game Start uncompressed: the .slp's first bytes are
    // rebuilt from its head (lib/slpz.ts). Not a readable .slpz: no header.
    if (isSlpzPath(file)) {
      let head: Buffer
      try {
        head = readSlpzHead(file)
      } catch {
        return new Uint8Array(0)
      }
      if (!looksLikeSlp(head)) return slpzSlpPrefix(head)
    }
    const buf = Buffer.alloc(HEADER_BYTES)
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0)
    return buf.subarray(0, n)
  } catch {
    return 'missing'
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* already closed */
    }
  }
}

function isBusy(error: unknown) {
  const code = (error as { code?: string })?.code || ''
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
}

async function run(): Promise<CpuScanCounts> {
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('busy_timeout = 10000')
  try {
    const cols = (
      db.prepare('PRAGMA table_info(files)').all() as { name: string }[]
    ).map((c) => c.name)
    // Games the missing-replays check found gone aren't tried.
    const where = cols.includes('missing')
      ? `${PENDING} AND missing = 0`
      : PENDING
    const counts: CpuScanCounts = {
      total: (
        db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${where}`).get() as {
          n: number
        }
      ).n,
      checked: 0,
      cpuGames: 0,
      missing: 0,
      unreadable: 0,
    }
    parentPort?.postMessage({ type: 'progress', ...counts })
    if (counts.total === 0) return counts

    const page = db.prepare(
      `SELECT id, path, players FROM files WHERE id > ? AND ${where} ORDER BY id LIMIT ?`,
    )
    // Only if the row is unchanged since it was read.
    const write = db.prepare(
      'UPDATE files SET players = ? WHERE id = ? AND players = ?',
    )
    let lastId = 0
    let outOfReach = 0
    while (!stopped) {
      while (paused && !stopped) await sleep(500)
      if (stopped) break
      const started = Date.now()
      const rows = page.all(lastId, batchSize) as {
        id: number
        path: string | null
        players: string
      }[]
      if (rows.length === 0) break
      const updates: { id: number; next: string; prev: string }[] = []
      for (const row of rows) {
        let players: unknown
        try {
          players = JSON.parse(row.players)
        } catch {
          players = null
        }
        if (!Array.isArray(players) || players.length === 0) continue
        const header = row.path ? readHeader(row.path) : 'missing'
        if (header === 'missing') {
          counts.missing += 1
          outOfReach += 1
          continue
        }
        outOfReach = 0
        const types = playerTypesFromHeader(header)
        if (!types) counts.unreadable += 1
        const next = withCpu(players, types)
        if (isCpuGame(next)) counts.cpuGames += 1
        updates.push({
          id: row.id,
          next: JSON.stringify(next),
          prev: row.players,
        })
      }
      // A busy project (an import or filter writing): wait and try again.
      for (let attempt = 0; ; attempt += 1) {
        try {
          db.transaction(() => {
            for (const u of updates) write.run(u.next, u.id, u.prev)
          })()
          break
        } catch (error) {
          if (!isBusy(error) || attempt >= 5 || stopped) throw error
          await sleep(2000)
        }
      }
      lastId = rows[rows.length - 1].id
      counts.checked += rows.length
      parentPort?.postMessage({ type: 'progress', ...counts })
      if (outOfReach >= GIVE_UP_AFTER) {
        counts.unreachable = true
        break
      }
      // Rest at least as long as the batch took: low priority.
      await sleep(Math.max(restMs, Date.now() - started))
    }
    return counts
  } finally {
    db.close()
  }
}

run()
  .then((counts) =>
    parentPort?.postMessage({ type: 'done', ...counts, stopped }),
  )
  .catch((error) =>
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }),
  )
