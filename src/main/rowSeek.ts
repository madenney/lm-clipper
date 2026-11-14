import type Database from 'better-sqlite3'

/**
 * The tray's window of rows by position, without a deep OFFSET (docs/tray-v2.md).
 *
 * `SELECT * ... LIMIT n OFFSET p` walks every skipped row: ~1.1 s per million on a
 * real combo table (5.6 s at row 5M). Instead each table keeps a sparse position
 * index: the sort key of every STRIDE-th row, found lazily the first time a
 * position is asked for and kept while the database is unchanged. A window at
 * position p then seeks to the nearest indexed key and skips under STRIDE rows.
 * The first visit to a deep position still walks that far once (only the key, and
 * it can be stopped by a newer request without losing what it found); every later
 * read anywhere before it costs a few milliseconds.
 *
 * Results are exactly the old query's: same ORDER BY, same rows, same columns.
 */
export const STRIDE = 1024

/** A row's place in tray order: (COALESCE(sort_order, id), id), or just id. */
export type SeekKey = { k: number; id: number }

/** How the index reads one table (SQLite below; a plain array in the tests). */
export interface SeekSource {
  /** The key `skip` rows on from `from` (inclusive; null = the first row), or
   *  null when the table ends first. */
  keyAt(_from: SeekKey | null, _skip: number): SeekKey | null
  /** Up to `limit` rows from `from` (inclusive; null = the start), after `skip`. */
  rows(_from: SeekKey | null, _skip: number, _limit: number): unknown[]
}

export const STOPPED = Symbol('stopped')

export class PositionIndex {
  readonly stride: number

  /** keys[j] is the key of the row at position j * stride; keys[0] is the start. */
  private keys: (SeekKey | null)[] = [null]

  /** No row at position keys.length * stride: the table is shorter. */
  private ended = false

  constructor(stride = STRIDE) {
    this.stride = stride
  }

  /** Positions whose seek point is known (0 … known - 1 are a short skip away). */
  get known() {
    return this.ended ? Infinity : this.keys.length * this.stride
  }

  /**
   * Where to read `offset` from: a key and a skip under one stride, null when the
   * table has no row there, or STOPPED when `stop` said a newer request is waiting
   * (the keys found so far are kept for it).
   */
  locate(
    offset: number,
    source: SeekSource,
    stop?: () => boolean,
  ): { from: SeekKey | null; skip: number } | null | typeof STOPPED {
    const j = Math.floor(offset / this.stride)
    while (this.keys.length <= j) {
      if (this.ended) return null
      if (stop && stop()) return STOPPED
      const next = source.keyAt(this.keys[this.keys.length - 1], this.stride)
      if (!next) {
        this.ended = true
        return null
      }
      this.keys.push(next)
    }
    return { from: this.keys[j], skip: offset - j * this.stride }
  }
}

/** A window of `limit` rows at `offset` through an index (null when stopped). */
export function readThroughIndex(
  index: PositionIndex,
  source: SeekSource,
  offset: number,
  limit: number,
  stop?: () => boolean,
): unknown[] | null {
  if (limit <= 0 || offset < 0) return []
  const at = index.locate(offset, source, stop)
  if (at === STOPPED) return null
  if (!at) return []
  return source.rows(at.from, at.skip, limit)
}

// ── SQLite ───────────────────────────────────────────────────────────

const TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** The custom-sort expression index exists (updateSortOrder made it): the same
 *  test DbWorker's itemsOrderBy and overview.ts use. */
function isCustomSorted(db: Database.Database, tableId: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name = ? LIMIT 1",
    )
    .get(`idx_${tableId}_sortorder`)
}

/** The two statements a table's reads use (`from`: they start at a key). */
export function seekSql(tableId: string, sorted: boolean, from: boolean) {
  const key = sorted ? 'COALESCE(sort_order, id)' : 'id'
  const order = sorted ? `${key}, id` : 'id'
  // (key, id) >= (@k, @id), spelled out: SQLite seeks the expression index with
  // this form, but scans it from the start for the row-value comparison.
  const where = !from
    ? ''
    : sorted
      ? `WHERE ${key} >= @k AND (${key} > @k OR id >= @id)`
      : 'WHERE id >= @id'
  const t = `"${tableId}"`
  return {
    keyAt: `SELECT ${key} AS k, id FROM ${t} ${where} ORDER BY ${order} LIMIT 1 OFFSET @skip`,
    rows: `SELECT * FROM ${t} ${where} ORDER BY ${order} LIMIT @limit OFFSET @skip`,
  }
}

export function sqliteSource(
  db: Database.Database,
  tableId: string,
  sorted: boolean,
): SeekSource {
  const stmts = new Map<string, Database.Statement>()
  const stmt = (sql: string) => {
    let s = stmts.get(sql)
    if (!s) {
      s = db.prepare(sql)
      stmts.set(sql, s)
    }
    return s
  }
  return {
    keyAt(from, skip) {
      const row = stmt(seekSql(tableId, sorted, !!from).keyAt).get({
        ...(from ?? {}),
        skip,
      }) as SeekKey | undefined
      return row ? { k: row.k, id: row.id } : null
    },
    rows(from, skip, limit) {
      return stmt(seekSql(tableId, sorted, !!from).rows).all({
        ...(from ?? {}),
        skip,
        limit,
      })
    },
  }
}

/**
 * Position indexes for one connection. They hold while nothing else has written:
 * `PRAGMA data_version` changes when another connection commits (the read lane's
 * connection never writes), and then they are all dropped.
 */
export class WindowCache {
  private dataVersion: number | null = null

  private indexes = new Map<string, PositionIndex>()

  private maxTables: number

  constructor(maxTables = 8) {
    this.maxTables = maxTables
  }

  index(tableId: string, sorted: boolean, dataVersion: number) {
    if (dataVersion !== this.dataVersion) {
      this.indexes.clear()
      this.dataVersion = dataVersion
    }
    const name = `${tableId}|${sorted ? 's' : 'u'}`
    let index = this.indexes.get(name)
    if (index) {
      this.indexes.delete(name) // most recent last
    } else {
      index = new PositionIndex()
      while (this.indexes.size >= this.maxTables)
        this.indexes.delete(this.indexes.keys().next().value as string)
    }
    this.indexes.set(name, index)
    return index
  }

  clear() {
    this.indexes.clear()
    this.dataVersion = null
  }
}

/**
 * The rows `SELECT * FROM table ORDER BY <tray order> LIMIT limit OFFSET offset`
 * returns, read through the table's position index in one read transaction (one
 * snapshot). Null when `stop` cut it short.
 */
export function readWindow(
  db: Database.Database,
  cache: WindowCache,
  tableId: string,
  offset: number,
  limit: number,
  stop?: () => boolean,
): unknown[] | null {
  if (!TABLE_RE.test(tableId)) throw new Error(`Invalid table id: ${tableId}`)
  return db.transaction(() => {
    // The first read starts the snapshot; data_version then describes it.
    const sorted = isCustomSorted(db, tableId)
    const version = db.pragma('data_version', { simple: true }) as number
    const index = cache.index(tableId, sorted, version)
    return readThroughIndex(
      index,
      sqliteSource(db, tableId, sorted),
      Math.floor(offset),
      Math.floor(limit),
      stop,
    )
  })()
}
