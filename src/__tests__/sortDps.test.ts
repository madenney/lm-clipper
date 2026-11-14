/**
 * @jest-environment node
 *
 * Sort by damage per second / total damage really orders the clips.
 *
 * The bug: both sorts summed a combo's move damage in a subquery over
 * json_each(json_extract(JSON, '$.combo.moves')). Inside that subquery an
 * unqualified `JSON` is json_each's own hidden column, not the row's, so every
 * clip's key was 0 and the sort changed nothing (found on a 1.25M-game Fox
 * parse: the "top DPS" 10 came out in parse order). The statement now names its
 * table `src`.
 *
 * On Node's own SQLite (node:sqlite): better-sqlite3 is built for Electron's ABI.
 */
import { getSortOrderExpr } from '../models/methods/sort'

type SqliteDb = {
  exec: (_sql: string) => void
  prepare: (_sql: string) => {
    run: (..._a: unknown[]) => unknown
    all: (..._a: unknown[]) => { n: string }[]
  }
}
// eslint-disable-next-line global-require
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (_path: string) => SqliteDb
}

const clip = (name: string, start: number, end: number, damages: number[]) =>
  JSON.stringify({
    name,
    startFrame: start,
    endFrame: end,
    combo: {
      moves: damages.map((damage, i) => ({
        frame: start + i,
        moveId: 1,
        damage,
      })),
    },
  })

function sorted(sortFunction: string, reverse = false): string[] {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE prev (id INTEGER PRIMARY KEY, JSON TEXT)')
  const ins = db.prepare('INSERT INTO prev (JSON) VALUES (?)')
  // name: damage / frames (per frame)
  ins.run(clip('slow', 100, 700, [10, 10, 10])) // 30 / 600 = 0.05
  ins.run(clip('fast', 100, 220, [10, 10, 10, 10])) // 40 / 120 = 0.333
  ins.run(clip('big', 100, 1100, [50, 50, 50])) // 150 / 1000 = 0.15
  ins.run(clip('open', 100, 0, [60, 60, 60, 60])) // never closed: no duration
  const expr = getSortOrderExpr(sortFunction, reverse)
  const rows = db
    .prepare(
      `SELECT json_extract(src.JSON, '$.name') AS n FROM prev AS src ` +
        `WHERE src.id >= ? AND src.id <= ? ORDER BY ${expr}`,
    )
    .all(1, 4)
  return rows.map((r) => r.n)
}

describe('sort by damage', () => {
  it('dps puts the highest damage per frame first and an unfinished combo last', () => {
    expect(sorted('dps')).toEqual(['fast', 'big', 'slow', 'open'])
  })

  it('reversed dps starts with the lowest', () => {
    expect(sorted('dps', true)).toEqual(['open', 'slow', 'big', 'fast'])
  })

  it('totalDamage puts the most damage first', () => {
    expect(sorted('totalDamage')).toEqual(['open', 'big', 'fast', 'slow'])
  })
})
