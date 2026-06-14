// Per-character recovery data for Edgeguard 2's "in range" test.
//
// `recoveryRange` = roughly how far (in Melee world units / pixels) from the
// ledge a character can realistically be and still make it back. It's used to
// decide whether a victim's recovery was *viable* — if they never got within
// this radius of the ledge, they were dying from a launch too far offstage
// (not an edgeguard). Floaty/multi-jump characters (Puff, Peach, Kirby) can be
// edgeguarded from much further out than fast-fallers (Fox, Falcon), which is
// exactly the bucket of "interesting" edgeguards a flat radius was missing.
//
// Values are informed estimates, NOT frame-perfect recovery distances — they're
// meant to be tuned. Keyed by Slippi internal character ID (see characters.js).

const recoveryRanges: Record<number, number> = {
  0: 95, // Captain Falcon — up-B grab range short, side-B horizontal
  1: 110, // Donkey Kong — spinning up-B, side-B pull
  2: 150, // Fox — firefox covers huge distance (slow/linear though)
  3: 120, // Mr. Game & Watch — parachute up-B + big jump
  4: 185, // Kirby — five jumps
  5: 70, // Bowser — very short koopa klaw recovery
  6: 90, // Link — tether + spin attack
  7: 120, // Luigi — tornado rise + missile
  8: 95, // Mario — short up-B, cape stall
  9: 105, // Marth — dolphin slash + side-B creep
  10: 170, // Mewtwo — long teleport + floaty double jump
  11: 120, // Ness — PK thunder (long but commitment-heavy)
  12: 185, // Peach — float + parasol
  13: 155, // Pikachu — two-segment quick attack
  14: 80, // Ice Climbers — short solo recovery (belay needs partner)
  15: 210, // Jigglypuff — five jumps
  16: 165, // Samus — tether + up-B + bomb jumps
  17: 130, // Yoshi — armored double jump
  18: 140, // Zelda — teleport
  19: 145, // Sheik — teleport
  20: 120, // Falco — firebird (shorter than Fox) + side-B
  21: 88, // Young Link — tether + spin
  22: 88, // Dr. Mario — short up-B
  23: 80, // Roy — worse dolphin slash, no side-B distance
  24: 140, // Pichu — quick attack (self-damage)
  25: 85, // Ganondorf — short up-B, side-B horizontal
}

export const DEFAULT_RECOVERY_RANGE = 110

export function getRecoveryRange(characterId: number): number {
  return recoveryRanges[characterId] ?? DEFAULT_RECOVERY_RANGE
}

export default recoveryRanges
