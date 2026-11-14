// Find moments and Download games are two forms over the same people, characters
// and tournaments. Switching between them carries those across, so "Fox combos by
// Mango" and "all of Mango's Fox games" don't mean retyping the search.
import type { DatabaseFilters } from '../../constants/database'
import type { ClipSearchFilters } from '../../constants/clipSearch'
import type { TournamentPick } from '../components/SearchBox'

const codes = (s: string) => s.split(',').filter(Boolean)

/** Download games → Pre-parsed moments (always without infinites and CPU games): keep what the clip form has no field for. */
export function gamesToClips(
  f: DatabaseFilters,
  base: ClipSearchFilters,
): ClipSearchFilters {
  return {
    ...base,
    attackerConnectCode: f.p1Codes.join(','),
    attackerCharacterId: f.p1Characters.slice(0, 1),
    victimConnectCode: f.p2Codes.join(','),
    victimCharacterId: f.p2Characters.slice(0, 1),
    tournaments: f.tournaments,
    // Pre-parsed moments never include wobbles/infinites or CPU games.
    includeCpu: false,
    includeInfinites: false,
  }
}

/** Pre-parsed moments → Download games: the games form keeps its own stage, dates, source. */
export function clipsToGames(
  c: ClipSearchFilters,
  base: DatabaseFilters,
): DatabaseFilters {
  return {
    ...base,
    p1Codes: codes(c.attackerConnectCode),
    p1Characters: c.attackerCharacterId,
    p2Codes: codes(c.victimConnectCode),
    p2Characters: c.victimCharacterId,
    tournaments: c.tournaments,
  }
}

/** Tournament chips to keep when only some keys carried over. */
export function picksFor(
  keys: string[],
  picks: TournamentPick[],
): TournamentPick[] {
  return picks.filter((p) => keys.includes(p.key))
}
