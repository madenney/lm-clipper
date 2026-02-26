export const sortOptions = [
  {
    id: 'chronological',
    shortName: 'chronological',
    requiresParser: false,
  },
  {
    id: 'dps',
    shortName: 'damage per second',
    requiresParser: true,
  },
  {
    id: 'moves',
    shortName: 'number of moves',
    requiresParser: true,
  },
  {
    id: 'length',
    shortName: 'clip length',
    requiresParser: false,
  },
]

/**
 * Returns a SQL ORDER BY expression for the given sort option.
 * Used by Worker.ts to sort entirely in SQLite (no JS memory overhead).
 */
export function getSortOrderExpr(
  sortFunction: string,
  reverse: boolean,
): string | null {
  switch (sortFunction) {
    case 'chronological': {
      const dir = reverse ? 'DESC' : 'ASC'
      return `CAST(json_extract(JSON, '$.startedAt') AS REAL) ${dir}`
    }
    case 'dps': {
      // Default: highest DPS first (DESC), reverse: lowest first (ASC)
      const dir = reverse ? 'ASC' : 'DESC'
      return (
        `(SELECT COALESCE(SUM(CAST(json_extract(value, '$.damage') AS REAL)), 0) ` +
        `FROM json_each(json_extract(JSON, '$.combo.moves'))) * 1.0 ` +
        `/ MAX(1, CAST(json_extract(JSON, '$.endFrame') AS INTEGER) ` +
        `- CAST(json_extract(JSON, '$.startFrame') AS INTEGER)) ${dir}`
      )
    }
    case 'moves': {
      // Default: fewest moves first (ASC), reverse: most first (DESC)
      const dir = reverse ? 'DESC' : 'ASC'
      return `COALESCE(json_array_length(json_extract(JSON, '$.combo.moves')), 0) ${dir}`
    }
    case 'length': {
      // Default: longest clips first (DESC), reverse: shortest first (ASC)
      const dir = reverse ? 'ASC' : 'DESC'
      return (
        `(CAST(json_extract(JSON, '$.endFrame') AS INTEGER) ` +
        `- CAST(json_extract(JSON, '$.startFrame') AS INTEGER)) ${dir}`
      )
    }
    default:
      return null
  }
}
