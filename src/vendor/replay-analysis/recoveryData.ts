// Per-character recovery range for the edgeguard parser's "in range" test.
//
// `recoveryRange` = how far (in Melee world units) from the ledge a character
// can be and still realistically make it back. Used two ways in edgeguard.ts:
//   - gate (b): if the victim NEVER got within this radius of the ledge, they
//     were dying from a launch too deep to survive — not an edgeguard.
//   - the denial test: a hit (or ledge-steal) only counts as *denying* the
//     recovery if it landed while the victim was inside this radius. A Falco
//     laser that clips a Marth 40 units from the ledge is an edgeguard; the
//     same laser pinging him 240 units out in the void is chip damage on
//     someone already dead.
//
// ---------------------------------------------------------------------------
// WHERE THESE NUMBERS COME FROM
//
// Measured, not guessed. Across 2,485 games from this project's own corpus we
// took every offstage excursion that ENDED IN A SUCCESSFUL RECOVERY (the player
// reached the ledge, or got back on stage in control, without dying) and
// recorded how far from the ledge they got. 81,329 such recoveries. Each value
// below is that character's 99th percentile, rounded to 5.
//
// Only frames at or BELOW stage level (y <= 0) count toward the distance — a
// player launched high ABOVE the stage is "far from the ledge" but merely
// drifts back down, which is not a recovery. (Measuring without that filter
// claimed Marth recovers from 256 units, which is nonsense.)
//
// So each number means: "past this distance, a successful recovery essentially
// never happened in 2,485 games of real play." The `rangeLeniency` filter option
// scales them if you want a looser or tighter net.
//
// LIMITS, honestly: this measures how far players DID come back from, not the
// theoretical maximum. A character who rarely gets launched deep can be
// underestimated. The low-sample characters (Pichu n=98, Zelda n=148, Roy n=213)
// are the least reliable — n is listed per row so you can weigh each one.
//
// One finding worth keeping: the old hand-guessed table spread these from 70 to
// 210, assuming Jigglypuff could recover from 3x farther than Bowser. In real
// play everyone clusters in 75-110 (Puff p99 93.3, Bowser p99 94.9) — past that
// you are too near the blast zone to come back, whatever you play. Character
// recovery differences show up in how OFTEN you get back, not from how far.
// ---------------------------------------------------------------------------

const recoveryRanges: Record<number, number> = {
  0: 95, //  Captain Falcon    n=6897   p99 94.0
  1: 85, //  Donkey Kong       n=848    p99 87.0
  2: 95, //  Fox               n=22757  p99 96.6
  3: 90, //  Mr. Game & Watch  n=323    p99 91.2
  4: 100, // Kirby             n=739    p99 99.6
  5: 95, //  Bowser            n=673    p99 94.9
  6: 90, //  Link              n=819    p99 89.3
  7: 80, //  Luigi             n=2012   p99 81.1
  8: 80, //  Mario             n=727    p99 79.9
  9: 90, //  Marth             n=9089   p99 90.3
  10: 105, // Mewtwo           n=497    p99 105.4
  11: 110, // Ness             n=410    p99 107.5
  12: 95, //  Peach            n=1407   p99 95.4
  13: 100, // Pikachu          n=1841   p99 98.1
  14: 75, //  Ice Climbers     n=1164   p99 72.6
  15: 95, //  Jigglypuff       n=2739   p99 93.3
  16: 100, // Samus            n=2619   p99 99.7
  17: 80, //  Yoshi            n=980    p99 77.4
  18: 95, //  Zelda            n=148    p99 95.5   (low sample)
  19: 90, //  Sheik            n=5907   p99 92.0
  20: 95, //  Falco            n=15569  p99 93.2
  21: 95, //  Young Link       n=326    p99 95.4
  22: 75, //  Dr. Mario        n=989    p99 76.2
  23: 80, //  Roy              n=213    p99 78.6   (low sample)
  24: 100, // Pichu            n=98     p99 98.4   (low sample)
  25: 90, //  Ganondorf        n=1491   p99 89.5
}

// Middle of the measured band, for any character not in the table.
export const DEFAULT_RECOVERY_RANGE = 95

export function getRecoveryRange(characterId: number): number {
  return recoveryRanges[characterId] ?? DEFAULT_RECOVERY_RANGE
}

export default recoveryRanges
