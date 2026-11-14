/* eslint-disable eqeqeq */
/*
 * ============================================================================
 * PHANTOM HITS PARSER (phantom) — how it works, in plain English
 * ============================================================================
 *
 * WHAT A PHANTOM HIT ACTUALLY IS (per UnclePunch / SmashWiki "glancing blow")
 *   A phantom is a hitbox that overlaps a hurtbox by LESS THAN 0.01 units — the
 *   collision bubbles are barely tangential rather than properly overlapping.
 *   Melee resolves it as a "glancing blow" with three defining, DOCUMENTED
 *   properties:
 *     1. It deals HALF the move's damage and NO knockback / no flinch.
 *     2. The DEFENDER is frozen for the attack's hitlag, but the ATTACKER is NOT
 *        frozen — they keep moving through their animation. (A normal hit freezes
 *        BOTH players.)
 *     3. The damage is not applied until the defender's freeze frames run out —
 *        it lands at the END of the freeze, not on contact. (The game holds it in
 *        case the move connects cleanly on a later freeze frame.)
 *   The classic example is a "phantom Rest": Puff's Rest grazes, deals half
 *   damage with no knockback, freezes only the defender, and leaves the Puff
 *   asleep and free to be punished.
 *
 * WHY THE OBVIOUS SIGNALS DON'T WORK (things this is NOT)
 *   "Damage but no knockback" alone matches loads of NON-phantoms: crouch-cancels
 *   and teched/ceiling'd hits (the DEFENDER kills their own knockback — but it's a
 *   normal hit, so BOTH players still freeze), multi-hit drill links, weak pokes,
 *   and projectiles (a laser's shooter never freezes, but the laser deals full
 *   damage ON CONTACT). Phantom hits are RARE (~1 in 8-20 games), so any detector
 *   firing once per game is wrong.
 *
 * THE DETECTION — two documented signatures, both required
 *   For each hit the DEFENDER takes (their `hitlagRemaining` rises 0 -> >0):
 *     A. ASYMMETRIC HITLAG. The ATTACKER's `hitlagRemaining` is 0 on that frame —
 *        the attacker is NOT frozen while the defender is. This alone excludes
 *        every normal hit (both freeze), including crouch-cancels and teched hits.
 *     B. DELAYED DAMAGE. No damage lands DURING the defender's freeze; it appears
 *        only AFTER the freeze ends. This excludes projectiles (a laser's shooter
 *        also isn't frozen, but the laser deals its damage immediately on contact,
 *        not after a freeze) and any remaining normal-hit noise.
 *   Together these two are specific to the phantom mechanic. Validated on ~270
 *   real games: ~1 phantom per 8 games, and it flags the known phantom Rest.
 *   (Attribution is via the defender's `lastHitBy`; grabs/pummels are excluded.)
 *
 * INPUT MODES
 *   Scans the window it's handed: [item.startFrame, item.endFrame]. Off the Files
 *   table that's the whole game; off clips it's just that clip. Each phantom's
 *   OUTPUT clip is [hit - leadIn, hit + tail], clamped to the real game bounds.
 * ============================================================================
 */
import type { Frames } from './types'

// Grabbed / captured action states (held, pummeled, thrown) — a pummel isn't a
// phantom; exclude the defender being grabbed.
function isCaptureState(a: number): boolean {
  return a >= 0xd3 && a <= 0xe4
}

// Cap on how far we scan a single freeze (safety; real hitlag is well under this).
const MAX_FREEZE = 30
// Damage under this during the freeze still counts as "no damage during freeze".
const DURING_EPS = 0.5

type FSample = {
  pct: number
  a: number
  hl: number // hitlagRemaining (the hit-freeze)
  lhb: number | null // lastHitBy (attacker index)
  lal: number | null // lastAttackLanded (move id)
}

function sample(
  frames: Record<string, any>,
  frame: number,
  idx: number,
): FSample | null {
  const p = frames[frame]?.players?.[idx]?.post
  if (!p) return null
  return {
    pct: p.percent ?? 0,
    a: p.actionStateId,
    hl: p.hitlagRemaining ?? 0,
    lhb: p.lastHitBy ?? null,
    lal: p.lastAttackLanded ?? null,
  }
}

export type PhantomMetrics = {
  hitFrame: number
  damage: number // % dealt (delayed, applied after the freeze — a phantom's half-damage)
  hitlag: number // defender's freeze length
  // The ATTACKER's action state at the graze = the phantoming move (reliable —
  // unlike lastAttackLanded, which is stale on a phantom). The Phantom Filter's
  // Move option matches on this (e.g. Rest = states 369-372).
  attackerState: number
  attackId: number | null // lastAttackLanded (STALE for phantoms; kept for reference only)
  victimState: number // action state the defender was in
  victimPercent: number
}

export type PhantomEvent = {
  attackerIndex: number
  victimIndex: number
  metrics: PhantomMetrics
}

/** First and last frame numbers present, or null for an empty game. */
export function frameBounds(
  frames: Frames | Record<string, any>,
): { min: number; max: number } | null {
  let min = Infinity
  let max = -Infinity
  for (const k of Object.keys(frames)) {
    const n = Number(k)
    if (Number.isNaN(n)) continue
    if (n < min) min = n
    if (n > max) max = n
  }
  return max === -Infinity ? null : { min, max }
}

/**
 * Phantom hits between `participants` (player indexes, in order) within
 * [scanStart, scanEnd]. Each participant is checked as the victim in turn.
 */
export function detectPhantoms(
  frames: Frames | Record<string, any>,
  participants: number[],
  scanStart: number,
  scanEnd: number,
  minDamage = 1,
): PhantomEvent[] {
  const events: PhantomEvent[] = []
  // Defender = the player being hit.
  for (const vi of participants) {
    let prevHL = 0
    for (let f = scanStart; f <= scanEnd; f += 1) {
      const v = sample(frames, f, vi)
      if (!v) {
        prevHL = 0
        continue
      }
      // Defender enters a hit-freeze this frame.
      if (v.hl > 0 && prevHL === 0 && !isCaptureState(v.a)) {
        const ai = v.lhb
        const atk = ai != null ? sample(frames, f, ai) : null
        // (A) ASYMMETRIC HITLAG: attacker landed the hit but is NOT frozen.
        if (
          ai != null &&
          ai !== vi &&
          participants.some((p) => p == ai) &&
          atk &&
          atk.hl === 0
        ) {
          // Length of the defender's freeze.
          let dur = 0
          for (let g = f; g <= f + MAX_FREEZE; g += 1) {
            const q = sample(frames, g, vi)
            if (q && q.hl > 0) dur = g - f
            else break
          }
          const p0 = sample(frames, f - 1, vi)?.pct ?? v.pct
          const duringPct = sample(frames, f + dur - 1, vi)?.pct ?? p0
          const afterPct = sample(frames, f + dur + 2, vi)?.pct ?? p0
          const dmgDuring = duringPct - p0
          const dmgTotal = afterPct - p0
          // (B) DELAYED DAMAGE: none during the freeze, appears after it ends.
          if (dmgDuring < DURING_EPS && dmgTotal >= minDamage) {
            events.push({
              attackerIndex: ai,
              victimIndex: vi,
              metrics: {
                hitFrame: f,
                damage: dmgTotal,
                hitlag: dur,
                attackerState: atk.a,
                attackId: atk.lal,
                victimState: v.a,
                victimPercent: v.pct,
              },
            })
          }
        }
      }
      prevHL = v.hl
    }
  }
  return events
}
