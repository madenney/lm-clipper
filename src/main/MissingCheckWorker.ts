/**
 * Checks a project's replays still exist on disk (docs/library-workspaces.md,
 * Part D). Runs off the main thread with its own connections to the project
 * and the replay library; the main process starts it when a project opens.
 *
 * workerData: { dbPath, libraryFolder, mode: 'check' | 'locate' | 'missingIds', folder? }
 *  - check: mark missing games (files.missing), repoint games whose recording
 *    is still on disk at another known path, report what's missing.
 *  - locate: match missing games to files under `folder`, repoint, then check.
 *  - missingIds: ids of the project's missing games (for Remove from project).
 * Replies { type: 'done', report?, ids? } or { type: 'error', message }.
 */
import { parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { MissingReport, groupGoneFolders, matchMoved } from './missingReplays'
import { LIBRARY_DB_NAME } from './replayLibrary'
import { isReplayPath } from '../lib/replayPath'

const { dbPath, libraryFolder, mode, folder } = workerData as {
  dbPath: string
  libraryFolder: string
  mode: 'check' | 'locate' | 'missingIds'
  folder?: string
}

const CHUNK = 5000
const exists = (p: string) => fs.existsSync(p)

// Case-insensitive file systems by default (Windows, macOS): compare names
// without case, or a path stored as "Game.slp" would look missing.
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'
const nameKey = (n: string) => (FOLD_CASE ? n.toLowerCase() : n)

/**
 * Whether a replay file exists, reading each folder's listing once instead of
 * one stat per file: a 2.8M-game project on a network drive is a few thousand
 * folder reads instead of millions of round trips. Rows come in import order,
 * so folders repeat in runs; a small cache of recent folders is enough.
 */
const listings = new Map<string, Set<string> | null>()
function fileExists(p: string): boolean {
  const dir = path.dirname(p)
  let names = listings.get(dir)
  if (names === undefined) {
    try {
      names = new Set(fs.readdirSync(dir).map(nameKey))
    } catch {
      names = null // folder gone (or unreadable): the file is missing
    }
    listings.set(dir, names)
    if (listings.size > 256) listings.delete(listings.keys().next().value!)
  }
  return !!names && names.has(nameKey(path.basename(p)))
}

function openProject() {
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('busy_timeout = 10000')
  const cols = (
    db.prepare('PRAGMA table_info(files)').all() as { name: string }[]
  ).map((c) => c.name)
  if (!cols.includes('missing')) {
    try {
      db.exec('ALTER TABLE files ADD COLUMN missing INTEGER NOT NULL DEFAULT 0')
    } catch (e) {
      if (!/duplicate column name/i.test((e as Error)?.message || '')) throw e
    }
  }
  return db
}

function openLibrary(): Database.Database | null {
  const file = path.join(libraryFolder, LIBRARY_DB_NAME)
  if (!fs.existsSync(file)) return null
  const db = new Database(file, { fileMustExist: true })
  db.pragma('busy_timeout = 10000')
  return db
}

/** Point games at new paths: the project's files rows and every clip row that
 *  names the old path, then the library's paths. */
function applyRemap(
  project: Database.Database,
  library: Database.Database | null,
  remap: Map<string, string>,
) {
  if (remap.size === 0) return
  const filterTables = (
    project
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'filter\\_%' ESCAPE '\\' AND name <> 'filter_runs'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
  project.transaction(() => {
    project.exec(
      'CREATE TEMP TABLE IF NOT EXISTS remap (old TEXT PRIMARY KEY, new TEXT)',
    )
    project.exec('DELETE FROM remap')
    const ins = project.prepare('INSERT OR REPLACE INTO remap VALUES (?, ?)')
    for (const [o, n] of remap) ins.run(o, n)
    project.exec(
      'UPDATE files SET path = (SELECT new FROM remap WHERE old = files.path), missing = 0 WHERE path IN (SELECT old FROM remap)',
    )
    for (const t of filterTables) {
      project.exec(
        `UPDATE "${t}" SET JSON = json_set(JSON, '$.path', (SELECT new FROM remap WHERE old = json_extract("${t}".JSON, '$.path')))
         WHERE json_extract(JSON, '$.path') IN (SELECT old FROM remap)`,
      )
    }
  })()
  if (!library) return
  const copy = library.prepare(
    `INSERT INTO paths (path, gameId, size, mtime, missing, checkedAt)
     SELECT ?, gameId, ?, ?, 0, ? FROM paths WHERE path = ?
     ON CONFLICT(path) DO UPDATE SET gameId = excluded.gameId, size = excluded.size,
       mtime = excluded.mtime, missing = 0, checkedAt = excluded.checkedAt`,
  )
  library.transaction(() => {
    for (const [o, n] of remap) {
      let st: fs.Stats | null = null
      try {
        st = fs.statSync(n)
      } catch {
        /* gone again */
      }
      copy.run(
        n,
        st?.size ?? null,
        st ? Math.floor(st.mtimeMs) : null,
        Date.now(),
        o,
      )
    }
  })()
}

function check(
  project: Database.Database,
  library: Database.Database | null,
): MissingReport {
  const page = project.prepare(
    'SELECT id, path, missing FROM files WHERE id > ? ORDER BY id LIMIT ?',
  )
  const nowMissing: { id: number; path: string }[] = []
  const nowFound: number[] = []
  let total = 0
  let lastId = 0
  for (;;) {
    const rows = page.all(lastId, CHUNK) as {
      id: number
      path: string
      missing: number
    }[]
    if (rows.length === 0) break
    for (const r of rows) {
      total++
      const gone = !r.path || !fileExists(r.path)
      if (gone) nowMissing.push({ id: r.id, path: r.path })
      else if (r.missing) nowFound.push(r.id)
    }
    lastId = rows[rows.length - 1].id
    parentPort?.postMessage({ type: 'progress', checked: total })
  }

  // The same recording still on disk at another known path: repoint quietly.
  const remap = new Map<string, string>()
  // First: the Replay Library folder was moved (Settings), so its files are
  // at the same place under the new folder.
  const moves =
    library &&
    library
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='moves'",
      )
      .get()
      ? (library
          .prepare('SELECT fromPrefix, toPrefix FROM moves ORDER BY at DESC')
          .all() as { fromPrefix: string; toPrefix: string }[])
      : []
  for (const m of nowMissing) {
    for (const mv of moves) {
      if (!m.path.startsWith(mv.fromPrefix)) continue
      const candidate = mv.toPrefix + m.path.slice(mv.fromPrefix.length)
      if (fileExists(candidate)) {
        remap.set(m.path, candidate)
        break
      }
    }
  }
  if (library && nowMissing.length) {
    const sibling = library.prepare(
      `SELECT p2.path FROM paths p1 JOIN paths p2 ON p2.gameId = p1.gameId AND p2.path <> p1.path
       WHERE p1.path = ?`,
    )
    for (const m of nowMissing) {
      if (remap.has(m.path)) continue
      const alt = (sibling.all(m.path) as { path: string }[]).find((r) =>
        exists(r.path),
      )
      if (alt) remap.set(m.path, alt.path)
    }
  }
  applyRemap(project, library, remap)
  const stillMissing = nowMissing.filter((m) => !remap.has(m.path))

  // Mark only what changed (rewriting every row would rewrite the whole table).
  const setMissing = project.prepare(
    'UPDATE files SET missing = ? WHERE id = ?',
  )
  project.transaction(() => {
    for (const m of stillMissing) setMissing.run(1, m.id)
    for (const id of nowFound) setMissing.run(0, id)
  })()

  const downloadable: string[] = []
  if (library && stillMissing.length) {
    const mark = library.prepare(
      'UPDATE paths SET missing = 1, checkedAt = ? WHERE path = ?',
    )
    const idOf = library.prepare(
      'SELECT g.replayId FROM paths p JOIN games g ON g.id = p.gameId WHERE p.path = ? AND g.replayId IS NOT NULL',
    )
    const now = Date.now()
    library.transaction(() => {
      for (const m of stillMissing) {
        mark.run(now, m.path)
        const row = idOf.get(m.path) as { replayId: string } | undefined
        if (row) downloadable.push(row.replayId)
      }
    })()
  }

  const { folders } = groupGoneFolders(
    stillMissing.map((m) => m.path).filter(Boolean),
    exists,
  )
  return {
    projectPath: dbPath,
    total,
    missing: stillMissing.length,
    repointed: remap.size,
    // A folder only counts as "gone" if it held more than one game.
    folders: folders.filter((f) => f.count > 1),
    downloadable,
  }
}

/** Every .slp and .slpz under `root` (no symlink loops: links are not followed). */
function findReplays(root: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && isReplayPath(e.name)) {
        try {
          out.push({ path: full, size: fs.statSync(full).size })
        } catch {
          /* vanished */
        }
      }
    }
  }
  return out
}

try {
  const project = openProject()
  const library = openLibrary()
  try {
    if (mode === 'missingIds') {
      const ids = (
        project.prepare('SELECT id FROM files WHERE missing = 1').all() as {
          id: number
        }[]
      ).map((r) => r.id)
      parentPort?.postMessage({ type: 'done', ids })
    } else {
      if (mode === 'locate') {
        if (!folder) throw new Error('No folder to search.')
        const missing = (
          project.prepare('SELECT path FROM files WHERE missing = 1').all() as {
            path: string
          }[]
        ).map((r) => r.path)
        const sizeOf = library?.prepare('SELECT size FROM paths WHERE path = ?')
        const withSizes = missing.map((p) => ({
          path: p,
          size:
            (sizeOf?.get(p) as { size: number | null } | undefined)?.size ??
            null,
        }))
        applyRemap(project, library, matchMoved(withSizes, findReplays(folder)))
      }
      parentPort?.postMessage({ type: 'done', report: check(project, library) })
    }
  } finally {
    project.close()
    library?.close()
  }
} catch (error) {
  parentPort?.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
}
