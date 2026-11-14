/** True for a .slp or .slpz path (case-insensitive). Dependency-free so the renderer can use it. */
export function isReplayPath(p: string): boolean {
  return /\.slpz?$/i.test(p)
}
