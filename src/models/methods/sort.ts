export const sortOptions = [
  {
    id: 'chronological',
    shortName: 'chronological',
    tooltip: 'Sort by game start time (oldest first)',
    requiresParser: false,
  },
  {
    id: 'dps',
    shortName: 'damage per second',
    tooltip: 'Sort by damage per second (highest first)',
    requiresParser: true,
  },
  {
    id: 'totalDamage',
    shortName: 'total damage',
    tooltip: 'Sort by total combo damage (highest first)',
    requiresParser: true,
  },
  {
    id: 'moves',
    shortName: 'number of moves',
    tooltip: 'Sort by move count (fewest first)',
    requiresParser: true,
  },
  {
    id: 'length',
    shortName: 'clip length',
    tooltip: 'Sort by clip duration in frames (longest first)',
    requiresParser: false,
  },
  {
    id: 'startPercent',
    shortName: 'start percent',
    tooltip:
      "Sort by the opponent's percent when the combo started (lowest first)",
    requiresParser: true,
  },
  {
    id: 'endPercent',
    shortName: 'end percent',
    tooltip:
      "Sort by the opponent's percent when the combo ended (highest first)",
    requiresParser: true,
  },
  {
    id: 'stage',
    shortName: 'stage',
    tooltip: 'Group clips by stage',
    requiresParser: false,
  },
  {
    id: 'matchup',
    shortName: 'character matchup',
    tooltip: 'Group clips by comboer and comboee character pair',
    requiresParser: true,
  },
  {
    id: 'random',
    shortName: 'random',
    tooltip: 'Shuffle clips into a random order',
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
    case 'totalDamage': {
      // Default: highest damage first (DESC), reverse: lowest first (ASC)
      const dir = reverse ? 'ASC' : 'DESC'
      return (
        `(SELECT COALESCE(SUM(CAST(json_extract(value, '$.damage') AS REAL)), 0) ` +
        `FROM json_each(json_extract(JSON, '$.combo.moves'))) ${dir}`
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
    case 'startPercent': {
      // Default: lowest start percent first (ASC), reverse: highest first (DESC)
      const dir = reverse ? 'DESC' : 'ASC'
      return `COALESCE(CAST(json_extract(JSON, '$.combo.startPercent') AS REAL), 0) ${dir}`
    }
    case 'endPercent': {
      // Default: highest end percent first (DESC), reverse: lowest first (ASC)
      const dir = reverse ? 'ASC' : 'DESC'
      return `COALESCE(CAST(json_extract(JSON, '$.combo.endPercent') AS REAL), 0) ${dir}`
    }
    case 'stage': {
      // Default: group by stage ascending, reverse: descending
      const dir = reverse ? 'DESC' : 'ASC'
      return `COALESCE(CAST(json_extract(JSON, '$.stage') AS INTEGER), 0) ${dir}`
    }
    case 'matchup': {
      // Group by comboer char then comboee char
      const dir = reverse ? 'DESC' : 'ASC'
      return (
        `COALESCE(CAST(json_extract(JSON, '$.comboer.characterId') AS INTEGER), -1) ${dir}, ` +
        `COALESCE(CAST(json_extract(JSON, '$.comboee.characterId') AS INTEGER), -1) ${dir}`
      )
    }
    case 'random': {
      return 'RANDOM()'
    }
    default:
      return null
  }
}
