/**
 * The replay library: what Clipper knows about every replay it has seen, local
 * or downloaded (docs/library-workspaces.md, Part A). `library.sqlite` lives in
 * the Replay Library folder (Settings > Paths, default ~/Documents/Lunar
 * Clipper/Library), which also holds the replays downloaded from the Lunar
 * Database, each once (docs/clip-search.md, Phase 3).
 *
 *   games  one row per recording: its header (players, stage, length…), and
 *          when known its content hash (the database's fileHash) and replayId
 *   paths  where a game is on disk (absolute), with the size and mtime it had,
 *          so an unchanged file is recognised without parsing it again
 *
 * These functions are synchronous better-sqlite3 calls: they run only in
 * DbWorker (via dbAsync `libraryCall`) on their own connection, never on the
 * main thread.
 */
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { FileInterface } from '../constants/types'

export const LIBRARY_DB_NAME = 'library.sqlite'
export const REPLAY_ID_RE = /^[a-f0-9]{24}$/

/** Where a downloaded replay lives inside the library. ObjectIds start with a
 *  timestamp, so folders are keyed by the last two hex digits (256 folders).
 *  Downloads are kept as .slpz unless "Keep downloaded replays compressed" is
 *  off (config keepDownloadsCompressed); older ones are .slp. */
export function libraryRelativePath(
  replayId: string,
  ext: '.slp' | '.slpz' = '.slp',
): string {
  if (!REPLAY_ID_RE.test(replayId)) throw new Error('Invalid replay id.')
  return path.join('replays', replayId.slice(-2), `${replayId}${ext}`)
}

/** The library file a downloaded game already has, in either form, or null. */
export function libraryFileFor(
  folder: string,
  replayId: string,
): string | null {
  for (const ext of ['.slpz', '.slp'] as const) {
    const p = path.join(folder, libraryRelativePath(replayId, ext))
    if (fs.existsSync(p)) return p
  }
  return null
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    contentHash TEXT UNIQUE,
    replayId TEXT UNIQUE,
    header TEXT,
    addedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS paths (
    path TEXT PRIMARY KEY,
    gameId INTEGER NOT NULL REFERENCES games(id),
    size INTEGER,
    mtime INTEGER,
    missing INTEGER NOT NULL DEFAULT 0,
    checkedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS paths_game ON paths(gameId);
  CREATE TABLE IF NOT EXISTS detections (
    gameId INTEGER NOT NULL REFERENCES games(id),
    detector TEXT NOT NULL,
    version INTEGER NOT NULL,
    paramsKey TEXT NOT NULL,
    rows TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (gameId, detector, version, paramsKey)
  );
  CREATE TABLE IF NOT EXISTS moves (
    fromPrefix TEXT NOT NULL,
    toPrefix TEXT NOT NULL,
    at INTEGER NOT NULL
  );
`

const connections = new Map<string, Database.Database>()

function fileStat(p: string): { size: number; mtime: number } | null {
  try {
    const s = fs.statSync(p)
    return { size: s.size, mtime: Math.floor(s.mtimeMs) }
  } catch {
    return null
  }
}

/** Phase 3's first schema (`replays`, library-relative paths) -> games/paths. */
function migrateV1(db: Database.Database, root: string) {
  const old = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='replays'",
    )
    .get()
  if (!old) return
  const rows = db
    .prepare('SELECT replayId, fileHash, path, addedAt FROM replays')
    .all() as {
    replayId: string
    fileHash: string | null
    path: string
    addedAt: number
  }[]
  db.transaction(() => {
    for (const r of rows) {
      const abs = path.resolve(root, r.path)
      if (!abs.startsWith(`${root}${path.sep}`)) continue
      const gameId = upsertGame(db, r.fileHash, r.replayId, r.addedAt)
      setPath(db, abs, gameId)
    }
    db.exec('DROP TABLE replays')
  })()
}

function open(folder: string): Database.Database {
  const root = path.resolve(folder)
  const cached = connections.get(root)
  if (cached) return cached
  fs.mkdirSync(root, { recursive: true })
  const db = new Database(path.join(root, LIBRARY_DB_NAME))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA)
  migrateV1(db, root)
  connections.set(root, db)
  return db
}

export function closeLibraries() {
  for (const db of connections.values()) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (_) {
      // ignore
    }
  }
  connections.clear()
}

/** The game with this hash or replayId (merging what's known), or a new one. */
function upsertGame(
  db: Database.Database,
  contentHash: string | null,
  replayId: string | null,
  addedAt = Date.now(),
): number {
  const byHash = contentHash
    ? (db
        .prepare('SELECT id, replayId FROM games WHERE contentHash = ?')
        .get(contentHash) as
        | { id: number; replayId: string | null }
        | undefined)
    : undefined
  if (byHash) {
    if (replayId && !byHash.replayId) {
      const taken = db
        .prepare('SELECT 1 FROM games WHERE replayId = ?')
        .get(replayId)
      if (!taken)
        db.prepare('UPDATE games SET replayId = ? WHERE id = ?').run(
          replayId,
          byHash.id,
        )
    }
    return byHash.id
  }
  const byId = replayId
    ? (db.prepare('SELECT id FROM games WHERE replayId = ?').get(replayId) as
        | { id: number }
        | undefined)
    : undefined
  if (byId) {
    if (contentHash)
      db.prepare(
        'UPDATE games SET contentHash = COALESCE(contentHash, ?) WHERE id = ?',
      ).run(contentHash, byId.id)
    return byId.id
  }
  return Number(
    db
      .prepare(
        'INSERT INTO games (contentHash, replayId, addedAt) VALUES (?, ?, ?)',
      )
      .run(contentHash, replayId, addedAt).lastInsertRowid,
  )
}

/** Point `p` at a game, recording the file's current size and mtime. */
function setPath(db: Database.Database, p: string, gameId: number) {
  const st = fileStat(p)
  db.prepare(
    `INSERT INTO paths (path, gameId, size, mtime, missing, checkedAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET gameId = excluded.gameId, size = excluded.size,
       mtime = excluded.mtime, missing = excluded.missing, checkedAt = excluded.checkedAt`,
  ).run(p, gameId, st?.size ?? null, st?.mtime ?? null, st ? 0 : 1, Date.now())
}

export type LibraryLookup = {
  /** replayId -> absolute path, for replays in the library and still on disk. */
  have: Record<string, string>
  /** fileHash -> absolute path: the same recording stored under another id. */
  haveHashes: Record<string, string>
  /** Requested replayIds the library does not have. */
  missing: string[]
}

const CHUNK = 500
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',')

/** Which of `replayIds` (and, optionally, file hashes) the library has on
 *  disk. Entries whose file was deleted count as missing. */
export function libraryLookup(
  folder: string,
  replayIds: string[],
  fileHashes: string[] = [],
): LibraryLookup {
  const db = open(folder)
  const have: Record<string, string> = {}
  const haveHashes: Record<string, string> = {}
  const ids = [...new Set(replayIds.filter((id) => REPLAY_ID_RE.test(id)))]
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const rows = db
      .prepare(
        `SELECT g.replayId, p.path FROM games g JOIN paths p ON p.gameId = g.id
         WHERE g.replayId IN (${marks(chunk.length)})`,
      )
      .all(...chunk) as { replayId: string; path: string }[]
    for (const row of rows)
      if (!have[row.replayId] && fs.existsSync(row.path))
        have[row.replayId] = row.path
  }
  const hashes = [...new Set(fileHashes.filter(Boolean))]
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK)
    const rows = db
      .prepare(
        `SELECT g.contentHash, p.path FROM games g JOIN paths p ON p.gameId = g.id
         WHERE g.contentHash IN (${marks(chunk.length)})`,
      )
      .all(...chunk) as { contentHash: string; path: string }[]
    for (const row of rows)
      if (!haveHashes[row.contentHash] && fs.existsSync(row.path))
        haveHashes[row.contentHash] = row.path
  }
  return { have, haveHashes, missing: ids.filter((id) => !have[id]) }
}

/** The database replay id of a file in the library, if it came from there. */
export function libraryReplayIdForPath(
  folder: string,
  filePath: string,
): string | null {
  // Downloaded games sit at replays/<last 2>/<replayId>.slp (or .slpz).
  const m = /[\\/]replays[\\/][a-f0-9]{2}[\\/]([a-f0-9]{24})\.slpz?$/.exec(
    filePath,
  )
  if (m && filePath.startsWith(folder)) return m[1]
  try {
    const row = open(folder)
      .prepare(
        `SELECT g.replayId FROM games g JOIN paths p ON p.gameId = g.id
         WHERE p.path = ? AND g.replayId IS NOT NULL LIMIT 1`,
      )
      .get(filePath) as { replayId?: string } | undefined
    return row?.replayId && REPLAY_ID_RE.test(row.replayId)
      ? row.replayId
      : null
  } catch {
    return null
  }
}

export type LibraryEntry = { replayId: string; fileHash: string; path: string }

/** Record downloaded replays (absolute paths) under their replayId and hash. */
export function libraryRegister(
  folder: string,
  entries: LibraryEntry[],
): number {
  const db = open(folder)
  let count = 0
  db.transaction(() => {
    for (const e of entries) {
      if (!REPLAY_ID_RE.test(e.replayId) || !path.isAbsolute(e.path)) continue
      setPath(db, e.path, upsertGame(db, e.fileHash || null, e.replayId))
      count++
    }
  })()
  return count
}

/** What import learns about a file (models/File.ts), without its path/id. */
export type GameHeader = Omit<FileInterface, 'path' | 'id'>
export type FileSeen = { path: string; size: number; mtime: number }

/** Headers of files the library has already read, when the file is unchanged
 *  (same size and mtime). Import uses these instead of parsing again. */
export function libraryHeaders(
  folder: string,
  files: FileSeen[],
): Record<string, GameHeader> {
  const db = open(folder)
  const out: Record<string, GameHeader> = {}
  const get = db.prepare(
    `SELECT g.header FROM paths p JOIN games g ON g.id = p.gameId
     WHERE p.path = ? AND p.size = ? AND p.mtime = ? AND g.header IS NOT NULL`,
  )
  for (const f of files) {
    const row = get.get(f.path, f.size, Math.floor(f.mtime)) as
      | { header: string }
      | undefined
    if (!row) continue
    try {
      out[f.path] = JSON.parse(row.header)
    } catch {
      /* unreadable header: parse the file again */
    }
  }
  return out
}

/** Remember the headers import parsed. A file whose size or mtime changed is
 *  a different recording now, so it gets a new game. */
export function libraryRecordHeaders(
  folder: string,
  files: (FileSeen & { header: GameHeader })[],
): number {
  const db = open(folder)
  const known = db.prepare(
    'SELECT gameId, size, mtime FROM paths WHERE path = ?',
  )
  const setHeader = db.prepare('UPDATE games SET header = ? WHERE id = ?')
  const upsertPath = db.prepare(
    `INSERT INTO paths (path, gameId, size, mtime, missing, checkedAt) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(path) DO UPDATE SET gameId = excluded.gameId, size = excluded.size,
       mtime = excluded.mtime, missing = 0, checkedAt = excluded.checkedAt`,
  )
  const now = Date.now()
  db.transaction(() => {
    for (const f of files) {
      if (!path.isAbsolute(f.path)) continue
      const mtime = Math.floor(f.mtime)
      const row = known.get(f.path) as
        | { gameId: number; size: number | null; mtime: number | null }
        | undefined
      const gameId =
        row && row.size === f.size && row.mtime === mtime
          ? row.gameId
          : upsertGame(db, null, null, now)
      setHeader.run(JSON.stringify(f.header), gameId)
      upsertPath.run(f.path, gameId, f.size, mtime, now)
    }
  })()
  return files.length
}

// ── Detector cache (docs/library-workspaces.md, Part A) ──────────────
// Raw detector output per game, so a re-run with different filter settings, or
// the same games in another project, skips reading the replays. Keyed by the
// detector's version and the settings that change its output (e.g. the combo
// timeout). Used from filter worker threads (models/detectionCache.ts).

export type DetectionKey = {
  detector: string
  version: number
  paramsKey: string
}

/** Cached output for an unchanged file (same path, size, mtime), or null. */
export function libraryDetectionGet(
  folder: string,
  file: FileSeen,
  key: DetectionKey,
): string | null {
  const db = open(folder)
  const row = db
    .prepare(
      `SELECT d.rows FROM paths p JOIN detections d ON d.gameId = p.gameId
       WHERE p.path = ? AND p.size = ? AND p.mtime = ?
         AND d.detector = ? AND d.version = ? AND d.paramsKey = ?`,
    )
    .get(
      file.path,
      file.size,
      Math.floor(file.mtime),
      key.detector,
      key.version,
      key.paramsKey,
    ) as { rows: string } | undefined
  return row?.rows ?? null
}

export type DetectionPut = FileSeen &
  DetectionKey & {
    /** MD5 of the replay's .slp bytes (a .slpz decoded first, lib/slpz.ts), so
     *  one recording has one hash however it's stored. Downloaded games keep
     *  the database's fileHash instead (it's what the database compares). */
    contentHash: string
    rows: string
  }

/** Store detector output, learning the file's content hash on the way: a file
 *  with the same content as a known game becomes that game. */
export function libraryDetectionPut(folder: string, items: DetectionPut[]) {
  const db = open(folder)
  const pathRow = db.prepare(
    'SELECT gameId, size, mtime FROM paths WHERE path = ?',
  )
  const gameRow = db.prepare('SELECT contentHash FROM games WHERE id = ?')
  const byHash = db.prepare('SELECT id FROM games WHERE contentHash = ?')
  const setHash = db.prepare('UPDATE games SET contentHash = ? WHERE id = ?')
  const upsertPath = db.prepare(
    `INSERT INTO paths (path, gameId, size, mtime, missing, checkedAt) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(path) DO UPDATE SET gameId = excluded.gameId, size = excluded.size,
       mtime = excluded.mtime, missing = 0, checkedAt = excluded.checkedAt`,
  )
  const copyHeader = db.prepare(
    'UPDATE games SET header = COALESCE(header, (SELECT header FROM games WHERE id = ?)) WHERE id = ?',
  )
  const putRow = db.prepare(
    `INSERT OR REPLACE INTO detections (gameId, detector, version, paramsKey, rows, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const now = Date.now()
  db.transaction(() => {
    for (const it of items) {
      if (!path.isAbsolute(it.path)) continue
      const mtime = Math.floor(it.mtime)
      const row = pathRow.get(it.path) as
        | { gameId: number; size: number | null; mtime: number | null }
        | undefined
      const unchanged = row && row.size === it.size && row.mtime === mtime
      const sameContent = byHash.get(it.contentHash) as
        | { id: number }
        | undefined
      let gameId: number
      if (sameContent) {
        gameId = sameContent.id
        // Keep what import learned about this path (its header).
        if (unchanged && row!.gameId !== gameId)
          copyHeader.run(row!.gameId, gameId)
      } else if (unchanged) {
        gameId = row!.gameId
        const g = gameRow.get(gameId) as { contentHash: string | null }
        if (!g.contentHash) setHash.run(it.contentHash, gameId)
      } else {
        gameId = upsertGame(db, it.contentHash, null, now)
      }
      upsertPath.run(it.path, gameId, it.size, mtime, now)
      putRow.run(gameId, it.detector, it.version, it.paramsKey, it.rows, now)
    }
  })()
}

/** Size of the detector cache, for Settings ("Clear detector cache"). */
export function libraryDetectionStats(folder: string) {
  const db = open(folder)
  return db
    .prepare(
      'SELECT COUNT(DISTINCT gameId) AS entries, COALESCE(SUM(LENGTH(rows)), 0) AS bytes FROM detections',
    )
    .get() as { entries: number; bytes: number }
}

/** What the library holds: games with a file on disk, and how many of those
 *  came from the Lunar Database (shown in Lunar Database › Transfers). */
export function librarySummary(folder: string) {
  const db = open(folder)
  return db
    .prepare(
      `SELECT COUNT(*) AS games, COUNT(replayId) AS fromDatabase FROM games g
       WHERE EXISTS (SELECT 1 FROM paths p WHERE p.gameId = g.id AND p.missing = 0)`,
    )
    .get() as { games: number; fromDatabase: number }
}

/**
 * Forget games the user deleted from Clipper (the Replays tray): their paths,
 * and each game no other path still names, with its cached detections. Only
 * the index changes: the replay files stay on disk, wherever they are (also
 * the ones downloaded into the library folder). Returns the games forgotten.
 */
export function libraryForget(folder: string, filePaths: string[]): number {
  // No library yet: nothing to forget (and don't create one).
  if (!fs.existsSync(path.join(path.resolve(folder), LIBRARY_DB_NAME))) return 0
  const db = open(folder)
  const wanted = [
    ...new Set(
      filePaths
        .filter((p) => typeof p === 'string' && p.length > 0)
        .flatMap((p) => [p, path.resolve(p)]),
    ),
  ]
  let forgotten = 0
  db.transaction(() => {
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const chunk = wanted.slice(i, i + CHUNK)
      const games = (
        db
          .prepare(
            `SELECT DISTINCT gameId FROM paths WHERE path IN (${marks(chunk.length)})`,
          )
          .all(...chunk) as { gameId: number }[]
      ).map((r) => r.gameId)
      db.prepare(
        `DELETE FROM paths WHERE path IN (${marks(chunk.length)})`,
      ).run(...chunk)
      if (games.length === 0) continue
      const orphans = (
        db
          .prepare(
            `SELECT id FROM games WHERE id IN (${marks(games.length)})
             AND NOT EXISTS (SELECT 1 FROM paths p WHERE p.gameId = games.id)`,
          )
          .all(...games) as { id: number }[]
      ).map((r) => r.id)
      if (orphans.length === 0) continue
      const m = marks(orphans.length)
      db.prepare(`DELETE FROM detections WHERE gameId IN (${m})`).run(
        ...orphans,
      )
      forgotten += db
        .prepare(`DELETE FROM games WHERE id IN (${m})`)
        .run(...orphans).changes
    }
  })()
  return forgotten
}

export function libraryDetectionClear(folder: string) {
  const db = open(folder)
  db.exec('DELETE FROM detections')
  db.pragma('wal_checkpoint(TRUNCATE)')
}

// ── Moving the library folder (Settings > Paths > Replay Library) ────

/** After the library's files moved from `oldFolder` to `newFolder` (opened at
 *  its new place): rewrite its paths and remember the move, so projects that
 *  still name the old paths are repointed when they next open
 *  (MissingCheckWorker). */
export function libraryRelocated(newFolder: string, oldFolder: string) {
  const from = `${path.resolve(oldFolder)}${path.sep}`
  const to = `${path.resolve(newFolder)}${path.sep}`
  const db = open(newFolder)
  db.transaction(() => {
    db.prepare(
      'UPDATE paths SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?',
    ).run(to, from.length + 1, from.length, from)
    db.prepare(
      'INSERT INTO moves (fromPrefix, toPrefix, at) VALUES (?, ?, ?)',
    ).run(from, to, Date.now())
  })()
}

/** Folder moves this library has been through, newest first. */
export function libraryMoves(folder: string) {
  return open(folder)
    .prepare('SELECT fromPrefix, toPrefix FROM moves ORDER BY at DESC')
    .all() as { fromPrefix: string; toPrefix: string }[]
}

export const LIBRARY_FNS = {
  libraryLookup,
  libraryRegister,
  libraryHeaders,
  libraryRecordHeaders,
  libraryDetectionStats,
  libraryDetectionClear,
  librarySummary,
  libraryForget,
  libraryRelocated,
  libraryClose: () => closeLibraries(),
}
export type LibraryFns = typeof LIBRARY_FNS
