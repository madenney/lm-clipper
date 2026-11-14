/**
 * The Minimum hits / Minimum damage boxes of Find clips. A search that did not run because the
 * text was not a valid number gave no sign at all (the count just kept the old results), and a
 * decimal comma ("12,5", common outside the US) was "invalid". The comma now means the dot and a
 * bad value says so.
 */

/** Typed text as the search wants it: no spaces, a decimal comma read as a dot. */
export const normalizeDecimalInput = (raw: string): string =>
  raw.replace(/\s+/g, '').replace(',', '.')

export const hitsValid = (text: string): boolean =>
  !text || /^\d{1,3}$/.test(text)

export const damageValid = (text: string): boolean =>
  !text || /^\d{1,3}(\.\d+)?$/.test(text)

/** What is wrong with the two boxes, or null when both are fine (or empty). */
export function limitsProblem(
  minHits: string,
  minDamage: string,
): string | null {
  if (!hitsValid(minHits))
    return 'Minimum hits: use a whole number from 1 to 999.'
  if (!damageValid(minDamage))
    return 'Minimum damage: use a number from 0 to 999, like 45 or 12.5.'
  return null
}
