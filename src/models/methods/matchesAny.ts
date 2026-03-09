/**
 * Check if a value matches any entry in a param (single value or array).
 * Returns true if param is empty/falsy (no constraint).
 */
const matchesAny = (value: any, param: any) => {
  if (!param || (Array.isArray(param) && param.length === 0)) return true
  const arr = Array.isArray(param) ? param : [param]
  return arr.some((v: any) => String(v) === String(value))
}

export default matchesAny
