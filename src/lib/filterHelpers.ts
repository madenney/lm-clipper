/**
 * Check if a value matches any entry in a param (single value or array).
 * Returns true if param is empty/falsy (no constraint).
 */
export const matchesAny = (value: any, param: any) => {
  if (!param || (Array.isArray(param) && param.length === 0)) return true
  const arr = Array.isArray(param) ? param : [param]
  return arr.some((v: any) => String(v) === String(value))
}

/**
 * Parse an int param safely. Returns defaultVal if empty/NaN/negative.
 * Clamps to [min, max] if provided.
 */
export function safeInt(
  value: any,
  defaultVal: number,
  min?: number,
  max?: number,
): number {
  if (value === '' || value === undefined || value === null) return defaultVal
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (Number.isNaN(n)) return defaultVal
  let result = n
  if (min !== undefined && result < min) result = min
  if (max !== undefined && result > max) result = max
  return result
}

/**
 * Normalize a tag/CC param into a lowercase string array.
 * Handles: string (semicolon-separated), string[], or falsy.
 */
export function parseSemicolonParam(
  param: string | string[] | undefined | null,
): string[] {
  if (!param) return []
  // "mang0; zain" and a trailing ";" must work: trimmed, and no empty entries
  // (an empty entry would match a player whose name is empty).
  const parts = Array.isArray(param)
    ? param.map((t: string) => String(t))
    : param.split(';')
  return parts.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)
}

/** The largest of these numbers (0 when there are none). A loop, not
 *  Math.max(...list): spreading a long game's 200k frame numbers overflows the
 *  call stack. */
export function maxOf(numbers: Iterable<number>): number {
  let max = 0
  // eslint-disable-next-line no-restricted-syntax
  for (const n of numbers) if (n > max) max = n
  return max
}

/**
 * Check if a player matches character/tag/CC constraints.
 * Returns false if the player fails any non-empty constraint.
 */
export function matchesPlayer(
  player: { characterId: number; displayName?: string; connectCode?: string },
  charParam: any,
  tagParam: string | string[] | undefined | null,
  ccParam: string | string[] | undefined | null,
): boolean {
  if (!matchesAny(player.characterId, charParam)) return false

  const tags = parseSemicolonParam(tagParam)
  if (tags.length > 0) {
    const name = (player.displayName || '').toLowerCase()
    if (tags.indexOf(name) === -1) return false
  }

  const codes = parseSemicolonParam(ccParam)
  if (codes.length > 0) {
    const code = (player.connectCode || '').toLowerCase()
    if (codes.indexOf(code) === -1) return false
  }

  return true
}
