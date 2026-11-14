import type Database from 'better-sqlite3'

/**
 * The tray's overview data (docs/tray-v2.md): for every row of a results table, in
 * the tray's order, its id plus three bytes (stage + tone, attacker character,
 * victim character). This is what lets the far-out GPU view draw millions of clips: no
 * row's JSON is parsed in JavaScript, SQLite's json_extract reads just those fields.
 *
 * Read in chunks with a keyset cursor (the last row's sort key and id), not
 * OFFSET, so the millionth chunk costs the same as the first.
 *
 * Results tables made since 2026-10-11 carry the three fields as stored generated
 * columns (RESULTS_TABLE_COLUMNS): SQLite fills them as each row is written, by
 * any insert or update, so the overview reads three small integers per row
 * instead of parsing every row's JSON (about 3.5x faster on a warm 1M table).
 * Older tables, and the files table, are read with json_extract as before; a
 * re-run recreates the table, which gives it the columns.
 */
export const OVERVIEW_BYTES = 3
/** A missing character. */
export const OVERVIEW_NONE = 255
/**
 * The first byte is the stage in its low 6 bits (Melee's stage ids stop at 32;
 * a missing or unknown stage is OVERVIEW_STAGE_NONE) and the card's tone in its
 * top 2 (TONE_*: the kill / standout ring, cardSummary.ts tone). Spare bits, so
 * the tone costs no memory on a 48M-clip table.
 */
export const OVERVIEW_STAGE_BITS = 6
export const OVERVIEW_STAGE_MASK = (1 << OVERVIEW_STAGE_BITS) - 1
export const OVERVIEW_STAGE_NONE = OVERVIEW_STAGE_MASK
export const TONE_NONE = 0
/** A combo that killed (not a quit-out), a pressure sequence ending in a kill. */
export const TONE_KILL = 1
/** An edgeguard scoring EDGEGUARD_HOT_SCORE or more. */
export const TONE_HOT = 2
/** cardSummary.ts EDGEGUARD_HOT_SCORE (main can't import the renderer's). */
export const OVERVIEW_HOT_SCORE = 45

/** A row's tone (TONE_*) in SQL, by cardSummary.ts summarizeClip's rules. */
const toneSql = (json: string) => `CASE
    WHEN json_type(${json}, '$.combo.moves') = 'array' THEN
      CASE WHEN COALESCE(json_extract(${json}, '$.combo.didKill'), 0) != 0
             AND COALESCE(json_extract(${json}, '$.combo.earlyQuit'), 0) = 0
           THEN ${TONE_KILL} ELSE ${TONE_NONE} END
    WHEN json_type(${json}, '$.edgeguardMetrics') = 'object' THEN
      CASE WHEN (CASE WHEN json_type(${json}, '$.edgeguardScore') IN ('integer', 'real')
                      THEN json_extract(${json}, '$.edgeguardScore')
                      WHEN json_type(${json}, '$.edgeguardMetrics.score') IN ('integer', 'real')
                      THEN json_extract(${json}, '$.edgeguardMetrics.score') END) >= ${OVERVIEW_HOT_SCORE}
           THEN ${TONE_HOT} ELSE ${TONE_NONE} END
    WHEN json_type(${json}, '$.highlightMetrics') = 'object' THEN ${TONE_NONE}
    WHEN json_type(${json}, '$.pressureMetrics') = 'object' THEN
      CASE WHEN COALESCE(json_extract(${json}, '$.pressureMetrics.endedInKill'), 0) != 0
           THEN ${TONE_KILL} ELSE ${TONE_NONE} END
    ELSE ${TONE_NONE} END`

export type OverviewCursor = { key: number; id: number } | null

export type OverviewChunk = {
  /** Row ids, in tray order. */
  ids: Uint32Array
  /** OVERVIEW_BYTES per row: stage | tone << 6, attacker char, victim char. */
  packed: Uint8Array
  /** Pass back to continue; null when this was the last chunk. */
  next: OverviewCursor
}

const TABLE_RE = /^(files|[A-Za-z0-9_-]{1,80})$/

/** The stored overview columns, read in place of json_extract when a table has them. */
export const OVERVIEW_COLUMNS = ['ov_stage', 'ov_char1', 'ov_char2'] as const
/** Stored since 2026-10-16; tables from before have the three above without it. */
export const OVERVIEW_TONE_COLUMN = 'ov_tone'

/**
 * A results table's columns, for CREATE TABLE. The overview columns come before
 * JSON: a column after a row's JSON sits behind its overflow pages once the
 * JSON outgrows a page. They hold the raw values (byte() below still clamps).
 * Generated columns can't be added to an existing table, only created with it.
 */
export const RESULTS_TABLE_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ov_stage GENERATED ALWAYS AS (json_extract(JSON, '$.stage')) STORED,
  ov_char1 GENERATED ALWAYS AS (COALESCE(json_extract(JSON, '$.comboer.characterId'),
    json_extract(JSON, '$.players[0].characterId'))) STORED,
  ov_char2 GENERATED ALWAYS AS (COALESCE(json_extract(JSON, '$.comboee.characterId'),
    json_extract(JSON, '$.players[1].characterId'))) STORED,
  ov_tone GENERATED ALWAYS AS (${toneSql('JSON')}) STORED,
  JSON TEXT,
  sort_order INTEGER DEFAULT NULL`

/** Which stored overview columns a results table has (newer tables only). */
function storedColumns(db: Database.Database, tableId: string) {
  if (tableId === 'files' || !TABLE_RE.test(tableId))
    return { chars: false, tone: false }
  // table_xinfo, not table_info: table_info leaves generated columns out.
  const cols = new Set(
    (
      db.prepare(`PRAGMA table_xinfo("${tableId}")`).all() as {
        name: string
      }[]
    ).map((c) => c.name),
  )
  return {
    chars: OVERVIEW_COLUMNS.every((c) => cols.has(c)),
    tone: cols.has(OVERVIEW_TONE_COLUMN),
  }
}

/** Whether a results table has the stored overview columns (newer tables only). */
export function hasStoredOverview(db: Database.Database, tableId: string) {
  return storedColumns(db, tableId).chars
}

/** Whether a results table also has the stored tone (tables since 2026-10-16). */
export function hasStoredTone(db: Database.Database, tableId: string) {
  return storedColumns(db, tableId).tone
}

function isCustomSorted(db: Database.Database, tableId: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name = ? LIMIT 1",
    )
    .get(`idx_${tableId}_sortorder`)
}

const int = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
const byte = (v: unknown) => {
  const n = int(v)
  return Number.isInteger(n) && n >= 0 && n < OVERVIEW_NONE ? n : OVERVIEW_NONE
}
/** The first byte: the stage in the low bits, the tone in the top two. */
export const stageToneByte = (stage: unknown, tone: unknown) => {
  const s = int(stage)
  const t = int(tone)
  return (
    (Number.isInteger(s) && s >= 0 && s < OVERVIEW_STAGE_NONE
      ? s
      : OVERVIEW_STAGE_NONE) |
    ((t === TONE_KILL || t === TONE_HOT ? t : TONE_NONE) << OVERVIEW_STAGE_BITS)
  )
}

export function readOverviewChunk(
  db: Database.Database,
  tableId: string,
  cursor: OverviewCursor,
  limit: number,
): OverviewChunk {
  if (!TABLE_RE.test(tableId)) throw new Error(`Invalid table id: ${tableId}`)
  const n = Math.max(1, Math.min(Math.floor(limit), 2_000_000))
  const sorted = tableId !== 'files' && isCustomSorted(db, tableId)
  const key = sorted ? 'COALESCE(sort_order, id)' : 'id'
  const stored = storedColumns(db, tableId)
  // Tables with the stored characters but no stored tone (2026-10-11 to -16)
  // read only the tone from the JSON.
  const tone = stored.tone ? OVERVIEW_TONE_COLUMN : toneSql('JSON')
  const fields =
    tableId === 'files'
      ? `stage AS s,
         json_extract(players, '$[0].characterId') AS a,
         json_extract(players, '$[1].characterId') AS b, 0 AS t`
      : stored.chars
        ? `ov_stage AS s, ov_char1 AS a, ov_char2 AS b, ${tone} AS t`
        : `json_extract(JSON, '$.stage') AS s,
         COALESCE(json_extract(JSON, '$.comboer.characterId'),
                  json_extract(JSON, '$.players[0].characterId')) AS a,
         COALESCE(json_extract(JSON, '$.comboee.characterId'),
                  json_extract(JSON, '$.players[1].characterId')) AS b,
         ${tone} AS t`
  // (key, id) > (@key, @id), spelled out: SQLite seeks the sort index with this
  // form, but scans it from the start with the row value (rowSeek.ts).
  const where = cursor
    ? sorted
      ? `WHERE ${key} >= @key AND (${key} > @key OR id > @id)`
      : 'WHERE id > @id'
    : ''
  const rows = db
    .prepare(
      `SELECT id, ${key} AS k, ${fields} FROM "${tableId}" ${where}
       ORDER BY ${sorted ? `${key}, id` : 'id'} LIMIT @n`,
    )
    .raw()
    .all({ ...(cursor ?? {}), n }) as [
    number,
    number,
    unknown,
    unknown,
    unknown,
    unknown,
  ][]

  const ids = new Uint32Array(rows.length)
  const packed = new Uint8Array(rows.length * OVERVIEW_BYTES)
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]
    ids[i] = r[0]
    packed[i * 3] = stageToneByte(r[2], r[5])
    packed[i * 3 + 1] = byte(r[3])
    packed[i * 3 + 2] = byte(r[4])
  }
  const last = rows[rows.length - 1]
  return {
    ids,
    packed,
    next: rows.length === n && last ? { key: last[1], id: last[0] } : null,
  }
}

/**
 * A cheap fingerprint of a table's contents, for the on-disk overview cache
 * (overviewCache.ts): the id range, whether it's custom-sorted, and the first and
 * last rows themselves. Instant even on 48M rows (rowid lookups only, no scan).
 * A re-run, an import or a removal changes it; a reorder is invalidated explicitly.
 */
export function readOverviewSignature(
  db: Database.Database,
  tableId: string,
): string {
  if (!TABLE_RE.test(tableId)) throw new Error(`Invalid table id: ${tableId}`)
  const range = db
    .prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM "${tableId}"`)
    .get() as { lo: number | null; hi: number | null }
  const col = tableId === 'files' ? 'path' : 'JSON'
  const at = (id: number | null) =>
    id == null
      ? ''
      : String(
          (
            db
              .prepare(`SELECT ${col} AS v FROM "${tableId}" WHERE id = ?`)
              .get(id) as { v?: string } | undefined
          )?.v ?? '',
        )
  const sorted = tableId !== 'files' && isCustomSorted(db, tableId)
  const head = at(range.lo)
  const tail = at(range.hi)
  // A short, stable digest of the edge rows (FNV-1a), not the rows themselves.
  let h = 0x811c9dc5
  for (const s of [head, tail])
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  return `${range.lo ?? 0}-${range.hi ?? 0}-${sorted ? 's' : 'u'}-${h.toString(16)}`
}
