/**
 * A tray selection (lib/selection.ts) turned into rows, in SQL, only when an
 * action needs them (delete, record, play, the selection's duration). Runs in
 * DbWorker. Ids are looked up by primary key: a run of consecutive ids is one
 * BETWEEN, scattered ids go in IN lists of at most ID_BATCH (SQLite allows ~32k
 * bound values per statement), so a selection never costs a scan of the table
 * unless it is "every row except these". Batches come in ascending id order.
 */
import type Database from 'better-sqlite3'
import type { Selection, IdBits } from '../lib/selection'

type SelDb = Database.Database

export const ID_BATCH = 5000
/** Runs at least this long are one BETWEEN instead of IN entries. */
const RUN_MIN = 16

/** Calls `fn` with a WHERE clause on `id` and its values, covering every id once. */
export function forEachIdBatch(
  bits: IdBits,
  fn: (_where: string, _params: number[]) => void,
) {
  let list: number[] = []
  const flush = () => {
    if (!list.length) return
    fn(`id IN (${list.map(() => '?').join(',')})`, list)
    list = []
  }
  bits.forEachRun((lo, hi) => {
    if (hi - lo + 1 >= RUN_MIN) {
      // Ids smaller than the run go first: batches come in ascending order.
      flush()
      fn('id BETWEEN ? AND ?', [lo, hi])
      return
    }
    for (let id = lo; id <= hi; id += 1) {
      list.push(id)
      if (list.length >= ID_BATCH) flush()
    }
  })
  flush()
}

/**
 * The SQL for one row's length in frames (end − start, never below 0), from the
 * table's columns: the files table has columns, results tables keep JSON. Null
 * when the table has neither.
 */
export function durationExpr(cols: Set<string>): string | null {
  let startExpr: string
  let endExpr: string
  if (cols.has('JSON') && !cols.has('startFrame')) {
    startExpr = "COALESCE(json_extract(JSON, '$.startFrame'), 0)"
    endExpr = `CASE
      WHEN COALESCE(json_extract(JSON, '$.endFrame'), 0) > 0
        THEN json_extract(JSON, '$.endFrame')
      ELSE COALESCE(json_extract(JSON, '$.lastFrame'), 0)
    END`
  } else {
    const hasStart = cols.has('startFrame')
    const hasEnd = cols.has('endFrame')
    const hasLast = cols.has('lastFrame')
    if (!hasStart && !hasEnd && !hasLast) return null
    startExpr = hasStart ? 'COALESCE(startFrame, 0)' : '0'
    endExpr = hasEnd
      ? hasLast
        ? 'CASE WHEN COALESCE(endFrame, 0) > 0 THEN endFrame ELSE COALESCE(lastFrame, 0) END'
        : 'COALESCE(endFrame, 0)'
      : hasLast
        ? 'COALESCE(lastFrame, 0)'
        : '0'
  }
  const diff = `(${endExpr}) - (${startExpr})`
  return `CASE WHEN (${diff}) > 0 THEN (${diff}) ELSE 0 END`
}

/** Frames and rows of the ids in `bits` that exist in the table. */
function framesOf(
  db: SelDb,
  tableId: string,
  bits: IdBits,
  expr: string | null,
) {
  let frames = 0
  let count = 0
  const sum = expr ? `SUM(${expr})` : '0'
  forEachIdBatch(bits, (where, params) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c, ${sum} AS f FROM "${tableId}" WHERE ${where}`,
      )
      .get(...params) as { c: number; f: number | null } | undefined
    count += row?.c ?? 0
    frames += row?.f ?? 0
  })
  return { frames, count }
}

/**
 * The selection's length in frames and its row count (rows since removed don't
 * count). "Every row except these" is the table's sum minus theirs.
 */
export function selectionFrames(
  db: SelDb,
  tableId: string,
  sel: Selection,
  cols: Set<string>,
): { frames: number; count: number } {
  const expr = durationExpr(cols)
  if (!sel.all) return framesOf(db, tableId, sel.bits, expr)
  const whole = db
    .prepare(
      `SELECT COUNT(*) AS c, ${expr ? `SUM(${expr})` : '0'} AS f FROM "${tableId}"`,
    )
    .get() as { c: number; f: number | null } | undefined
  const out = framesOf(db, tableId, sel.bits, expr)
  return {
    frames: (whole?.f ?? 0) - out.frames,
    count: (whole?.c ?? 0) - out.count,
  }
}

/** A growable list of ids. */
class IdList {
  ids = new Uint32Array(1024)

  length = 0

  push(id: number) {
    if (this.length === this.ids.length) {
      const grown = new Uint32Array(this.ids.length * 2)
      grown.set(this.ids)
      this.ids = grown
    }
    this.ids[this.length] = id
    this.length += 1
  }

  done() {
    return this.ids.slice(0, this.length)
  }
}

/**
 * The selected rows' ids in display order (`orderBy`: 'id', or the custom sort
 * 'COALESCE(sort_order, id), id'), at most `limit`. Named rows are looked up by
 * id; "every row except these" walks the table's ids in order.
 */
export function selectionIds(
  db: SelDb,
  tableId: string,
  sel: Selection,
  orderBy: string,
  limit = Infinity,
): Uint32Array {
  const out = new IdList()
  if (sel.all) {
    const rows = db
      .prepare(`SELECT id FROM "${tableId}" ORDER BY ${orderBy}`)
      .iterate() as Iterable<{ id: number }>
    for (const r of rows) {
      if (out.length >= limit) break
      if (!sel.bits.has(r.id)) out.push(r.id)
    }
    return out.done()
  }
  const sorted = orderBy !== 'id'
  const found: { id: number; k: number }[] = []
  forEachIdBatch(sel.bits, (where, params) => {
    if (!sorted) {
      for (const r of db
        .prepare(`SELECT id FROM "${tableId}" WHERE ${where} ORDER BY id`)
        .all(...params) as { id: number }[])
        if (out.length < limit) out.push(r.id)
      return
    }
    for (const r of db
      .prepare(
        `SELECT id, COALESCE(sort_order, id) AS k FROM "${tableId}" WHERE ${where}`,
      )
      .all(...params) as { id: number; k: number }[])
      found.push(r)
  })
  if (!sorted) return out.done()
  found.sort((a, b) => a.k - b.k || a.id - b.id)
  for (const r of found) {
    if (out.length >= limit) break
    out.push(r.id)
  }
  return out.done()
}
