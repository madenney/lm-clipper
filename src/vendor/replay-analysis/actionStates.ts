// Melee's common action-state ids (the same for every character; character
// specials start at 341), named as the game names them. Only the ones the
// detectors read are listed.
export const AS = {
  DEAD_LAST: 10,
  KNEE_BEND: 24, // jumpsquat
  JUMP_F: 25,
  JUMP_B: 26,
  DAMAGE_FALL: 38,
  SQUAT: 39,
  SQUAT_WAIT: 40,
  SQUAT_RV: 41,
  LANDING: 42,
  LANDING_FALL_SPECIAL: 43, // wavedash / waveland landing
  ATTACK_HI4: 63, // up smash
  ATTACK_AIR_N: 65,
  ATTACK_AIR_LW: 69,
  LANDING_AIR_N: 70,
  LANDING_AIR_LW: 74,
  DAMAGE_FIRST: 75, // DamageHi1
  DAMAGE_FLY_FIRST: 87, // DamageFlyHi (tumble launch)
  DAMAGE_LAST: 91, // DamageFlyRoll
  GUARD_ON: 178,
  GUARD: 179,
  GUARD_OFF: 180,
  GUARD_SET_OFF: 181, // shieldstun
  GUARD_REFLECT: 182, // powershield
  DOWN_FIRST: 183,
  DOWN_LAST: 198,
  PASSIVE_FIRST: 199,
  PASSIVE_LAST: 204,
  SHIELD_BREAK_FLY: 205,
  SHIELD_BREAK_LAST: 211, // FuraFura (dizzy)
  CATCH: 212,
  CATCH_PULL: 213,
  CATCH_DASH: 214,
  CATCH_DASH_PULL: 215,
  CATCH_WAIT: 216,
  CATCH_ATTACK: 217, // pummel
  CATCH_CUT: 218, // grab released
  THROW_F: 219,
  THROW_B: 220,
  THROW_HI: 221,
  THROW_LW: 222,
  CAPTURE_FIRST: 223,
  CAPTURE_CUT: 229,
  CAPTURE_JUMP: 230,
  CAPTURE_LAST: 232,
  ESCAPE_F: 233, // roll forward
  ESCAPE_B: 234, // roll back
  ESCAPE: 235, // spotdodge
  ESCAPE_AIR: 236, // airdodge
  THROWN_F: 239,
  THROWN_LW_WOMEN: 243,
  PASS: 244, // drop through a platform
  CLIFF_CATCH: 252,
  CLIFF_WAIT: 253,
  SPECIAL_FIRST: 341,
} as const

export const isDead = (a: number) => a >= 0 && a <= AS.DEAD_LAST
export const isDamaged = (a: number) =>
  (a >= AS.DAMAGE_FIRST && a <= AS.DAMAGE_LAST) || a === AS.DAMAGE_FALL
export const isCaptured = (a: number) =>
  a >= AS.CAPTURE_FIRST && a <= AS.CAPTURE_LAST
export const isThrown = (a: number) =>
  a >= AS.THROWN_F && a <= AS.THROWN_LW_WOMEN
export const isDown = (a: number) => a >= AS.DOWN_FIRST && a <= AS.DOWN_LAST
export const isTeching = (a: number) =>
  a >= AS.PASSIVE_FIRST && a <= AS.PASSIVE_LAST
export const isShielding = (a: number) =>
  a === AS.GUARD_ON ||
  a === AS.GUARD ||
  a === AS.GUARD_SET_OFF ||
  a === AS.GUARD_REFLECT
export const isShieldBroken = (a: number) =>
  a >= AS.SHIELD_BREAK_FLY && a <= AS.SHIELD_BREAK_LAST
export const isAerialAttack = (a: number) =>
  a >= AS.ATTACK_AIR_N && a <= AS.ATTACK_AIR_LW
/** Not able to act because of the opponent: hit, held, thrown, knocked down. */
export const isPunished = (a: number) =>
  isDamaged(a) ||
  isCaptured(a) ||
  isThrown(a) ||
  isDown(a) ||
  isTeching(a) ||
  isShieldBroken(a)

export const AERIALS = ['nair', 'fair', 'bair', 'uair', 'dair'] as const
export type Aerial = (typeof AERIALS)[number]
/** nair…dair for an aerial attack or its landing state. */
export function aerialOf(a: number): Aerial | null {
  if (isAerialAttack(a)) return AERIALS[a - AS.ATTACK_AIR_N]
  if (a >= AS.LANDING_AIR_N && a <= AS.LANDING_AIR_LW)
    return AERIALS[a - AS.LANDING_AIR_N]
  return null
}
