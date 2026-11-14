/**
 * What the Lunar Database knows about one replay, for the full-zoom card: where it
 * was played (tournament, set game, source, date, views) and both players' game
 * stats. Built in main from the website's /api/getReplay and /api/gameStats and
 * passed to the renderer, so everything here is checked and bounded.
 */
export type ReplayInfoPlayer = {
  playerIndex: number
  name: string | null
  connectCode: string | null
  characterId: number | null
  stocksLeft: number | null
  kills: number | null
  openings: number | null
  conversions: number | null
  damageDealt: number | null
  neutralWins: number | null
  counterHits: number | null
  inputsPerMinute: number | null
  lCancel: { success: number; fail: number } | null
  wavedashes: number | null
  wavelands: number | null
  dashDances: number | null
}

export type ReplayInfo = {
  replayId: string
  source: 'tournament' | 'netplay' | 'ranked' | null
  startAt: string | null
  tournamentName: string | null
  setGame: number | null
  viewCount: number | null
  /** playerIndex of the winner, when known. */
  winner: number | null
  /** False when the game has no extracted stats yet. */
  hasStats: boolean
  players: ReplayInfoPlayer[]
}

export const REPLAY_PAGE = (replayId: string) =>
  `https://www.lunarmelee.com/replay?id=${replayId}`

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const str = (v: unknown, max = 100): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

export function parseReplayInfo(
  replayId: string,
  replay: unknown,
  stats: unknown,
): ReplayInfo | null {
  const r = (replay && typeof replay === 'object' ? replay : null) as Record<
    string,
    any
  > | null
  if (!r || r._id !== replayId) return null
  const summary = (stats as { summary?: Record<string, any> } | null)?.summary
  const statPlayers: Record<string, any>[] = Array.isArray(summary?.players)
    ? summary!.players
    : []
  const basePlayers: Record<string, any>[] = Array.isArray(r.players)
    ? r.players
    : []
  const indexes = [
    ...new Set(
      [...basePlayers, ...statPlayers]
        .map((p) => p?.playerIndex)
        .filter((i) => Number.isInteger(i) && i >= 0 && i < 4),
    ),
  ].sort()
  const players = indexes.map((playerIndex): ReplayInfoPlayer => {
    const b = basePlayers.find((p) => p?.playerIndex === playerIndex) ?? {}
    const s = statPlayers.find((p) => p?.playerIndex === playerIndex) ?? {}
    const a = (s.actions ?? {}) as Record<string, any>
    const start = num(s.startStocks)
    const lost = num(s.stocksLost)
    return {
      playerIndex,
      name: str(b.tag) ?? str(b.displayName) ?? str(s.displayName),
      connectCode: str(b.connectCode, 20) ?? str(s.connectCode, 20),
      characterId: num(b.characterId) ?? num(s.characterId),
      stocksLeft:
        start != null && lost != null ? Math.max(0, start - lost) : null,
      kills: num(s.kills),
      openings: num(s.openings),
      conversions: num(s.successfulConversions),
      damageDealt: num(s.damageDealt),
      neutralWins: num(s.neutralWins),
      counterHits: num(s.counterHits),
      inputsPerMinute: num(s.inputsPerMinute),
      lCancel:
        a.lCancelCount && num(a.lCancelCount.success) != null
          ? {
              success: num(a.lCancelCount.success)!,
              fail: num(a.lCancelCount.fail) ?? 0,
            }
          : null,
      wavedashes: num(a.wavedashCount),
      wavelands: num(a.wavelandCount),
      dashDances: num(a.dashDanceCount),
    }
  })
  const source = ['tournament', 'netplay', 'ranked'].includes(r.source)
    ? (r.source as ReplayInfo['source'])
    : null
  return {
    replayId,
    source,
    startAt: str(r.startAt, 40),
    tournamentName: str(r.tournamentName, 200),
    setGame: num(r.setGame),
    viewCount: num(r.viewCount),
    winner: num(r.winner) ?? num(summary?.winner),
    hasStats: statPlayers.length > 0,
    players,
  }
}
