/** Blast zone a player died through, from their death action state (0-10). */
export type DeathDirection = 'down' | 'left' | 'right' | 'up'

/** Death direction from a stock's `deathAnimation`, or null if not a death state. */
export function getDeathDirection(
  actionStateId: number,
): DeathDirection | null {
  if (actionStateId > 10) return null
  switch (actionStateId) {
    case 0:
      return 'down'
    case 1:
      return 'left'
    case 2:
      return 'right'
    default:
      return 'up'
  }
}
