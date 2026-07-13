/* eslint-disable eqeqeq */
/*
 * ============================================================================
 * EDGEGUARDS PARSER (edgeguard) — how it works, in plain English
 * ============================================================================
 *
 * GOAL
 *   Find the clips where a player is killed BY AN EDGEGUARD: they get knocked
 *   offstage by a hit, try to recover, and are denied (hit back out, or their
 *   ledge taken) and die — without ever recovering in between. Each clip we
 *   keep is tagged with `edgeguardMetrics` (see EdgeguardMetrics) that the
 *   Edgeguards Filter can later refine, and a `score` ranking how interesting
 *   it is. We open .slp files but only compute STOCKS (death frames), not full
 *   stats, so it's ~⅓ the CPU of a normal parse.
 *
 * WHAT COUNTS AS AN EDGEGUARD (the governing rules)
 *   - The clip must START with the hit that sends the victim offstage.
 *   - After that hit, the victim must NOT become actionable again before dying.
 *     "Actionable / recovered" = back in control: standing/shielding/attacking
 *     on the stage, OR holding the ledge. If they grab the ledge or land on
 *     stage in control, they RECOVERED — that ends the edgeguard, and anything
 *     after is a separate situation. (Landing LAG is not "in control", so a
 *     forced onstage landing that gets punished is still one edgeguard.)
 *   - `maxActionableFrames` (default 0) allows a few in-control frames of slack
 *     before we call it a recovery.
 *
 * TWO INPUT MODES (see the default export at the bottom)
 *   - Combo mode: the input clips already carry comboer/comboee + an end frame.
 *     We pick the victim's stock that dies at/after that end and analyse it.
 *   - Files mode: we scan EVERY stock in the game; the victim is whoever lost
 *     the stock, the edgeguarder is the other player. Character / tag / connect-
 *     code filters decide which stocks we bother analysing.
 *   Either way the heavy lifting is in detectEdgeguard(), run once per candidate
 *   death. It returns a clip {startFrame, endFrame, metrics} or null (reject).
 *
 * detectEdgeguard() — THE STEPS, IN ORDER
 *
 *   1. KO GATE + which SIDE. Look at the victim on the frame before death.
 *      - If they died OFFSTAGE (out past the ledge band, or below the stage
 *        lip): that's a classic edgeguard KO and the death position tells us
 *        the side (left/right).
 *      - If they died near center / off the TOP (e.g. upsmashed out of a forced
 *        landing): death position tells us nothing, so we scan back up to
 *        SIDE_LOOKBACK (150) frames for the most recent clearly-offstage frame
 *        and take the side from there. No offstage frame nearby ⇒ it was a
 *        center-stage juggle, not an edgeguard ⇒ reject.
 *
 *   2. FLOOR the search window. An edgeguard can't span a frame where the
 *      edgeguarder wasn't actually guarding. Walking back from the death we
 *      stop at the first frame the edgeguarder is dead/respawning, OR is
 *      offstage in their OWN trouble (knockback or special-fall). That frame
 *      (`activeFloor`) — clamped by `exchangeFloor`, the later of the two
 *      players' current-stock spawns, and by the `maxLookbackFrames` cap — is
 *      as far back as the clip may reach.
 *
 *   3. WALK BACK TO THE LAUNCH. From the death, step backwards until the victim
 *      was last "recovered" (isRecovered: on the ledge, or grounded and not in
 *      hitstun/landing-lag). The first recovered frame we hit (allowing
 *      `maxActionableFrames` of slack) is the recovery boundary; everything
 *      after it is this edgeguard, and `startFrame` is the launch — the first
 *      not-in-control frame. If the not-in-control run instead reaches all the
 *      way to the floor, we never witnessed a launch (it belonged to a prior
 *      exchange) ⇒ reject.
 *
 *   4. RECONSTRUCT THE SEQUENCE in one forward pass over [startFrame, death),
 *      measuring everything at once:
 *        - hits: every frame the victim's PERCENT rises (catches each combo hit,
 *          even inside one run of hitstun).
 *        - recoveryFrame / recoveryAttempts: the first, and the count of
 *          distinct, recovery moves the victim got to start while offstage
 *          (double jump, air dodge, or any character special). The back-and-
 *          forth count is the strongest "interesting" signal.
 *        - minLedgeDist: closest the victim got to the ledge AFTER their first
 *          recovery attempt (measuring earlier would just catch the launch arc
 *          sweeping past the ledge and read as ~0 for everyone).
 *        - blockedByHit / ledgeSteal: a hit landed, or the edgeguarder sat on
 *          the ledge, AFTER the recovery attempt — i.e. the denial.
 *        - edgeguarderDepth: how far past the ledge / below the stage the
 *          edgeguarder committed. Continuous, and THE commitment signal — a
 *          binary "did they go offstage" was true 92% of the time (even a
 *          ledge-grab means briefly leaving the stage) and was removed.
 *        - stageTouches: times the victim was forced back onto the stage
 *          (ledge covered → onstage landing) — the rare forced-landing read.
 *        - maxDepthX / minY: how far out / how low the victim was taken.
 *
 *   5. GATES — keep the clip only if ALL hold:
 *        (a) the victim actually attempted to recover (recoveryFrame !== null);
 *        (a2) a non-offstage (off-the-top / onstage) KO needs stageTouches ≥ 1
 *             to prove a forced landing led into it — else it's an air juggle;
 *        (b) the victim got within their CHARACTER'S recovery range of the ledge
 *            (× the leniency knob) — they weren't dead-on-impact way out;
 *        (c) the return was actually denied: blockedByHit, or a ledge-steal (if
 *            ledge-steals are enabled). BOTH only count when they happen while
 *            the victim is still IN RANGE of the ledge (see below);
 *        (d) length: offstageFrames ≥ minOffstageFrames. (There is no
 *            commitment gate here — filter on edgeguarderDepth downstream in
 *            the Edgeguards Filter, which needs no .slp re-parse.)
 *
 *   5b. THE DENIAL TEST, and why projectiles work.
 *        A hit only DENIES a recovery if it lands while the victim is inside
 *        their recovery range of the ledge. This is what lets Falco's laser be
 *        judged correctly, in both directions:
 *          - laser clips a Marth 40 units from the ledge, mid-up-B → he was
 *            coming back and got knocked out of it → real edgeguard, counts;
 *          - laser pings a Marth 240 units out in the void → he was never
 *            getting back; it denied nothing → does not count.
 *        Same move, same damage, opposite verdicts. The discriminator is where
 *        the VICTIM was — not the move, the damage, or the gap between players.
 *        Without this, a player could stand on stage plinking lasers at a corpse
 *        falling to the blast zone and the parser would call it an edgeguard.
 *        The ledge-steal test carries the same rule.
 *
 *   6. PICK THE CLIP START — the first frame of the attacker's launching move.
 *        - firstOff: the first frame the victim crosses offstage.
 *        - connectFrame: the most recent PERCENT rise in [startFrame, firstOff]
 *          — the exact frame the knock-off hit landed. The search is bounded to
 *          this edgeguard's own window so it can never reach back across a prior
 *          recovery to a stale earlier hit. If there is NO hit in that window,
 *          the victim entered the offstage run on their own (recovered, then
 *          left the ledge / drifted off) — not an edgeguard ⇒ reject.
 *        - Back up from connectFrame while the EDGEGUARDER stays in the same
 *          action state (the attack), so the clip opens as the move begins, not
 *          mid-swing (capped at 45 frames so a stray state can't drag it back).
 *        - Lead-in: open `leadInFrames` (default 30) earlier still, for a beat
 *          of lead-up — clamped to the floor so it can't cross the edgeguarder's
 *          own death/respawn/recovery.
 *
 *   7. SCORE + RETURN. Build the interestingness score from the discriminative
 *      metrics (recovery attempts and forced-landing reads weigh most; plus
 *      ledge-clutch, the edgeguarder's depth/return, a clean putaway, and a
 *      small hit term), and return {startFrame: clipStart, endFrame: death,
 *      metrics}.
 * ============================================================================
 */
import { SlippiGame, StockType } from '@slippi/slippi-js'
import {
  edgeguardRects,
  DEFAULT_OFFSTAGE_BUFFER,
} from '../../constants/stageGeometry'
import { computeStocks } from '../../lib/slippiStocks'
import { getRecoveryRange } from '../../constants/recoveryData'
import matchesAny from './matchesAny'
import { matchesPlayer } from '../../lib/filterHelpers'
import {
  FileInterface,
  ClipInterface,
  EdgeguardParams,
  EventEmitterInterface,
  PlayerInterface,
} from '../../constants/types'

// Hitstun / knockback action states (DamageHi/N/Lw/Fly...). Being in one of
// these = the player is getting hit.
const damageStates = new Set([
  0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57,
  0x58, 0x59, 0x5a, 0x5b,
])

// Helpless special-fall states (FallSpecial/F/B) — a player in one of these
// offstage is recovering (post up-B / airdodge), not attacking.
const SPECIAL_FALL = new Set([0x23, 0x24, 0x25])

// Universal action states for ledge occupation (taking the ledge to deny a
// recovery — the core of a no-contact "ledge-steal" edgeguard).
const CLIFF_CATCH = 0xfc
const CLIFF_WAIT = 0xfd

// Landing-lag states: Landing, LandingFallSpecial, and the five aerial landings.
// Grounded but NOT in control — a forced onstage landing lives here.
const LANDING_LAG = new Set([0x2a, 0x2b, 0x46, 0x47, 0x48, 0x49, 0x4a])

// "Recovered" = the victim is back in control. Holding the ledge counts. Other-
// wise they must be GROUNDED (isAirborne false) and not in a vulnerable grounded
// state — hitstun or landing lag. Using isAirborne means ANY grounded in-control
// state counts (Wait, shield, attacks, grabs, rolls, spotdodge, crouch, ...)
// without hand-listing them. Landing lag is grounded but vulnerable, so a forced
// onstage landing still reads as part of the edgeguard.
function isRecovered(s: Sample): boolean {
  if (s.a >= CLIFF_CATCH && s.a <= 0x107) return true // on the ledge
  if (s.air) return false // airborne = not recovered onto the stage
  if (damageStates.has(s.a)) return false // grounded hitstun
  if (LANDING_LAG.has(s.a)) return false // landing lag
  return true // grounded and in control
}

// "Valid recovery attempt" signals — states a player can only enter once they
// have regained control offstage. We treat these as the victim actively trying
// to recover (vs. ragdolling out in pure hitstun):
//   - double jump (JumpAerialF/B)
//   - air dodge (EscapeAir) — wavedash/airdodge-to-ledge recoveries
//   - any character-specific special move (up-B / side-B recoveries). In Melee
//     action-state IDs 0-340 are universal; 341+ are per-character moves, which
//     offstage are almost always a recovery special. Heuristic, but no
//     per-character up-B table needed.
const JUMP_AERIAL_F = 0x1b
const JUMP_AERIAL_B = 0x1c
const ESCAPE_AIR = 0xec
const FIRST_CHARACTER_STATE = 341

function isRecoveryMove(a: number): boolean {
  return (
    a === JUMP_AERIAL_F ||
    a === JUMP_AERIAL_B ||
    a === ESCAPE_AIR ||
    a >= FIRST_CHARACTER_STATE
  )
}

type Rect = { xMin: number; xMax: number; yMin: number; yMax: number }
type Side = 'left' | 'right'

// How far back to look for the edgeguarded side when the victim is killed
// straight up (near center, no side from death position). Bounds the search to
// the recent forced-landing window; nothing offstage within this = a center
// juggle, not an edgeguard.
const SIDE_LOOKBACK = 150

type Sample = {
  x: number
  y: number
  a: number
  pct: number // damage % — rises by exactly each hit, even within one hitstun run
  air: boolean // isAirborne — true = off the ground / a platform
}

function sample(
  frames: Record<string, any>,
  frame: number,
  idx: number,
): Sample | null {
  const p = frames[frame]?.players?.[idx]?.post
  if (!p) return null
  return {
    x: p.positionX,
    y: p.positionY,
    a: p.actionStateId,
    pct: p.percent ?? 0,
    air: !!p.isAirborne,
  }
}

// Past xLine horizontally, or below yLine, on the side they died on.
function isOffstageAt(
  s: Sample,
  side: Side,
  xLine: number,
  yLine: number,
): boolean {
  const onDeathSide = side === 'right' ? s.x > 0 : s.x < 0
  if (!onDeathSide) return false
  return Math.abs(s.x) > xLine || s.y < yLine
}

// Is the victim out in the offstage/edge region on the side they died on?
// edge.xMin is the offstage line, a configurable buffer INSIDE where the stage
// ends — see DEFAULT_OFFSTAGE_BUFFER in constants/stageGeometry. This is the
// JUDGMENT call ("is this player in trouble"), used for the side read,
// stageTouches and recovery-attempt detection.
function isOffstage(s: Sample, side: Side, edge: Rect): boolean {
  return isOffstageAt(s, side, edge.xMin, edge.yMin)
}

// Did the victim PHYSICALLY leave the stage? Unbuffered — a factual test, used
// to anchor the launch window (the hit that knocked them off the stage). The
// buffered line must not be used here: it reads a victim standing near the
// ledge as already-offstage, collapsing the window so no launching hit is found.
function isOffstageStrict(
  s: Sample,
  side: Side,
  stageEnd: number,
  edge: Rect,
): boolean {
  return isOffstageAt(s, side, stageEnd, edge.yMin)
}

export type EdgeguardMetrics = {
  offstageFrames: number
  hits: number
  recoveryFrame: number | null
  minLedgeDist: number
  blockedByHit: boolean
  ledgeSteal: boolean
  maxDepthX: number
  minY: number
  // Discriminative metrics (added 2026-06-26). The originals above saturate
  // (ledgeSteal ~66% true, hits caps low) so they can't separate "interesting"
  // from "boring". These are continuous / count-based:
  //   recoveryAttempts  — distinct recovery moves the victim got to start before
  //                       dying = the back-and-forth contest (1 = boring gimp,
  //                       3+ = multi-exchange scramble).
  //   edgeguarderDepth  — how far past the ledge + below stage the EDGEGUARDER
  //                       ventured (their risk/style). THE commitment metric —
  //                       it replaced a binary `edgeguarderOffstage` that was
  //                       true 92% of the time (edgeguarding nearly always
  //                       involves leaving the stage, even just to grab ledge),
  //                       so the boolean couldn't tell a 60-unit dive from a
  //                       toe over the edge. Depth can: on-stage edgeguards
  //                       (lasers, ledge-traps) sit at 0-7, real chases 30+.
  //   edgeguarderReturned — edgeguarder made it back safely onstage at the kill
  //                       (a deep commit they survived reads as stylish).
  //   lastHitToDeath    — frames from the final hit to death; low = clean
  //                       putaway, high = lingering flail / self-destruct.
  //   stageTouches      — times the victim was forced back onto the stage during
  //                       the situation (edgeguarder covered the ledge, forcing
  //                       an onstage landing they then punished). The signature
  //                       of an option-coverage read; rare and premium.
  //   diedOffstage      — true = classic offstage KO (out a side / spiked); false
  //                       = killed onstage or off the top after a forced landing
  //                       (a punish read). Splits the two edgeguard flavours.
  recoveryAttempts: number
  edgeguarderDepth: number
  edgeguarderReturned: boolean
  lastHitToDeath: number
  stageTouches: number
  diedOffstage: boolean
  score: number
}

type Detection = {
  startFrame: number
  endFrame: number
  metrics: EdgeguardMetrics
}

type DetectOpts = {
  minOffstageFrames: number
  rangeLeniency: number // multiplier on the character's recovery range (1 = 100%)
  includeLedgeSteals: boolean
  maxLookbackFrames: number
  maxActionableFrames: number
  leadInFrames: number
}

function detectEdgeguard(
  stock: { endFrame?: number | null },
  victimIdx: number,
  victimCharId: number,
  edgeguarderIdx: number,
  frames: Record<string, any>,
  rects: { bz: Rect; edge: Rect; stageEnd: number },
  opts: DetectOpts,
  // The earliest frame this exchange can reach: the later of the two players'
  // current-stock spawn frames. The walk-back must never cross it — before it,
  // one of them was dead/respawning, so no edgeguard was happening.
  exchangeFloor: number,
): Detection | null {
  if (stock.endFrame == null) return null
  const deathFrame = stock.endFrame

  const { edge, stageEnd } = rects

  // 1. KO gate + side. The classic edgeguard kill is a blastzone death while
  //    the victim is offstage — out the SIDE or off the BOTTOM (spike). There
  //    the death position gives the edgeguarded side directly. But a forced
  //    onstage landing can be punished UP (e.g. Fox upsmash into the landing
  //    lag), killing off the top with the victim near center — there death
  //    position tells us nothing, so we read the side from the most recent
  //    clearly-offstage frame (the recovery they were just forced off of). No
  //    offstage frame within SIDE_LOOKBACK = a center-stage juggle, not an
  //    edgeguard, so we reject (also the cheap early-out for ordinary deaths).
  //    A non-offstage death is admitted only when a forced landing led into it
  //    (stageTouches >= 1, checked at the gates below).
  const death = sample(frames, deathFrame - 1, victimIdx)
  if (!death) return null
  const diedOffstage =
    death.y < rects.bz.yMax &&
    isOffstage(death, death.x >= 0 ? 'right' : 'left', edge)
  let side: Side
  if (diedOffstage) {
    side = death.x >= 0 ? 'right' : 'left'
  } else {
    let recoverySide: Side | null = null
    const sideFloor = deathFrame - 1 - SIDE_LOOKBACK
    for (let cf = deathFrame - 1; cf > sideFloor; cf -= 1) {
      const s = sample(frames, cf, victimIdx)
      if (!s) break
      const sd: Side = s.x >= 0 ? 'right' : 'left'
      if (isOffstage(s, sd, edge)) {
        recoverySide = sd
        break
      }
    }
    if (recoverySide === null) return null
    side = recoverySide
  }

  // The ledge point on the death side — used to measure whether the victim was
  // ever within recovery range. edge.xMax is the ledge-GRAB position (where a
  // character hangs), so a successful ledge grab measures ~0 away.
  const ledgeX = side === 'right' ? edge.xMax : -edge.xMax
  const ledgeY = 0

  // 2. Walk back from the KO to the launch. The edgeguard is the run of frames
  //    where the victim is NOT in control: offstage, in hitstun, in landing lag,
  //    in special-fall. The moment (walking back) the victim was last RECOVERED
  //    — actionable on the stage/a platform, or holding the ledge — the sequence
  //    ended; everything after that is the edgeguard, and it begins at the hit
  //    that launched them. Landing lag is NOT "recovered", so a forced onstage
  //    landing that gets punished stays one edgeguard. `maxActionableFrames`
  //    (default 0) allows a few in-control frames before calling it a recovery.
  // Floor the window at the edgeguarder's most recent not-in-play frame (death
  // or respawn platform). An edgeguard can't span a frame where the edgeguarder
  // was dead — so scanning back from the kill, the first such frame caps how far
  // the clip may reach. This catches both a respawn just before the exchange AND
  // the edgeguarder dying/trading mid-sequence. Action states <= 0x0D are dead /
  // Rebirth / RebirthWait; WAIT (0x0E) is the first live state. Bounded by the
  // maxLookback cap so the scan stays cheap.
  const maxFloor = deathFrame - 1 - opts.maxLookbackFrames
  const scanFloor = Math.max(exchangeFloor, maxFloor)
  let activeFloor = scanFloor
  for (let cf = deathFrame - 1; cf > scanFloor; cf -= 1) {
    const e = sample(frames, cf, edgeguarderIdx)
    if (!e) {
      activeFloor = cf
      break
    }
    // stageEnd, not edge.xMin: "were they physically off the stage" is a fact,
    // not a judgment. The buffered line would read an on-stage edgeguarder in
    // hitstun as offstage-in-trouble and clamp the floor, killing real clips.
    const egOffstage = Math.abs(e.x) > stageEnd || e.y < edge.yMin
    // The edgeguarder isn't edgeguarding when they're dead/respawning (<= 0x0D)
    // OR offstage in their OWN trouble — knocked back, or helpless in special-
    // fall after their own recovery move. The clip can't reach back across that:
    // before it, THEY were the one recovering, not guarding. (Offstage aerials /
    // double jumps used to attack are fine — only knockback & special-fall.)
    if (
      e.a <= 0x0d ||
      (egOffstage && (damageStates.has(e.a) || SPECIAL_FALL.has(e.a)))
    ) {
      activeFloor = cf
      break
    }
  }

  let startFrame = deathFrame - 1
  let actionableRun = 0
  const lookbackFloor = activeFloor
  for (let cf = deathFrame - 1; cf > lookbackFloor; cf -= 1) {
    const s = sample(frames, cf, victimIdx)
    if (!s) break
    if (isRecovered(s)) {
      actionableRun += 1
      if (actionableRun > opts.maxActionableFrames) break
    } else {
      actionableRun = 0
      startFrame = cf
    }
  }

  // Reject sequences whose non-recovered run reaches all the way back to the
  // floor: the victim was already offstage/helpless when the edgeguarder came
  // into play (a respawn, a trade, the exchange start), so we never witnessed
  // the launch — it belonged to a prior exchange. A real edgeguard begins at a
  // launch, so startFrame sits ABOVE the floor with a recovered frame just before
  // it. (Only when the floor is a real boundary, not the lookback cap.)
  if (activeFloor > maxFloor && startFrame - 1 <= activeFloor) return null

  // How close to the ledge the victim must be for a recovery to be plausible at
  // all (their character's measured range, see constants/recoveryData). Used for
  // gate (b) below AND, per-frame, to decide whether a hit actually DENIED the
  // recovery — see the denial test in the loop.
  const inRange = getRecoveryRange(victimCharId) * opts.rangeLeniency

  // 3. Single pass over the offstage window, reconstructing the sequence:
  //    recovery attempt -> in-range -> block-after-attempt -> death.
  let recoveryFrame: number | null = null
  let minLedgeDist = Infinity
  let hits = 0
  let prevPct: number | null =
    sample(frames, startFrame - 1, victimIdx)?.pct ?? null
  let blockedByHit = false // a hit that landed AFTER the recovery attempt
  let ledgeSteal = false // edgeguarder on the ledge AFTER the recovery attempt
  let maxDepthX = 0
  let minY = Infinity
  // Discriminative tracking (see EdgeguardMetrics doc).
  let recoveryAttempts = 0
  let prevRecovery = false // victim was in a recovery move last frame
  let lastAttemptFrame = -Infinity
  let hitSinceAttempt = false // a hit landed since we last counted an attempt
  let edgeguarderDepth = 0
  let lastHitFrame: number | null = null
  let stageTouches = 0 // times the victim was forced back onto the stage
  let wasOffstage = false
  // Is the victim, THIS frame, close enough to the ledge that a recovery is
  // still live? Gates both denial signals (hit + ledge-steal).
  let victimInRangeNow = false

  for (let f = startFrame; f < deathFrame; f += 1) {
    const v = sample(frames, f, victimIdx)
    victimInRangeNow = false
    if (v) {
      const offstage = isOffstage(v, side, edge)

      // Forced-landing read: the victim returning to the stage mid-situation
      // (edgeguarder covered the ledge, forcing an onstage landing they then
      // punish back off). Rare and high-skill — a strong "interesting" signal.
      if (wasOffstage && !offstage) stageTouches += 1
      wasOffstage = offstage

      // Recovery attempt: the victim entering a recovery move while offstage.
      // Count each DISTINCT attempt (the back-and-forth) — rising edge into a
      // recovery move, debounced so a single multi-state up-B isn't counted
      // repeatedly. A hit since the last attempt always lets the next one count
      // (that's exactly the "denied, tried again" sequence we want to reward).
      const isRec = offstage && isRecoveryMove(v.a)
      if (isRec && !prevRecovery) {
        if (recoveryFrame === null) recoveryFrame = f
        if (hitSinceAttempt || f - lastAttemptFrame > 12) {
          recoveryAttempts += 1
          lastAttemptFrame = f
          hitSinceAttempt = false
        }
      }
      prevRecovery = isRec

      // Distance to the ledge right now, and whether a recovery is still live
      // from here. `victimInRangeNow` is the key to the denial test below.
      const distNow = Math.hypot(v.x - ledgeX, v.y - ledgeY)
      victimInRangeNow = distNow <= inRange

      // In-range: closest the victim got to the ledge DURING THE RECOVERY (at or
      // after the first recovery attempt). Measuring it over the whole window
      // would count the initial launch — every victim's knockback arc sweeps
      // right past the ledge tip on the way out, so minLedgeDist would be ~0 for
      // any offstage death, making the in-range gate meaningless and inflating
      // the clutch score. Only the return trip tells us if they were "in range".
      if (offstage && recoveryFrame !== null) {
        if (distNow < minLedgeDist) minLedgeDist = distNow
      }

      // Hits on the victim — detected by PERCENT going up, so we catch every
      // individual hit even inside one continuous run of hitstun (a rising edge
      // into a damage state can't tell combo hits apart).
      //
      // A hit only DENIES the recovery if the victim was still in a position to
      // make it — inside their recovery range when it landed. This is what makes
      // projectiles work correctly: a Falco laser that clips a Marth 40 units
      // from the ledge, mid-up-B, is a textbook edgeguard and counts. The same
      // laser pinging him 240 units out in the void denied nothing — he was
      // already dead — and must not. Same move, same damage; what separates them
      // is where the VICTIM was, not what hit them or how far away the
      // edgeguarder stood.
      if (prevPct !== null && v.pct > prevPct) {
        hits += 1
        lastHitFrame = f
        hitSinceAttempt = true
        if (recoveryFrame !== null && f > recoveryFrame && victimInRangeNow) {
          blockedByHit = true
        }
      }
      prevPct = v.pct

      maxDepthX = Math.max(maxDepthX, Math.abs(v.x))
      minY = Math.min(minY, v.y)
    }

    const e = sample(frames, f, edgeguarderIdx)
    if (e) {
      const onDeathSide = side === 'right' ? e.x > 0 : e.x < 0
      // Continuous offstage commit: how far past the ledge tip (horizontally)
      // plus how far below the stage the edgeguarder ventured. Most edgeguards
      // the guarder barely dips a toe out (binary flag ~always true); the deep,
      // risky ones stand out here.
      if (onDeathSide) {
        const pastLedge = Math.max(0, Math.abs(e.x) - edge.xMax)
        const belowStage = Math.max(0, -e.y)
        const depth = pastLedge + belowStage
        if (depth > edgeguarderDepth) edgeguarderDepth = depth
      }
      // Ledge-steal block: edgeguarder occupying the ledge after the victim
      // committed to a recovery (they can't grab an occupied ledge). Same rule
      // as the hit test — it only DENIES anything if the victim was actually
      // close enough to be coming back for that ledge. Sitting on the ledge
      // while they die 200 units out steals nothing.
      if (
        onDeathSide &&
        (e.a === CLIFF_CATCH || e.a === CLIFF_WAIT) &&
        recoveryFrame !== null &&
        f >= recoveryFrame &&
        victimInRangeNow
      ) {
        ledgeSteal = true
      }
    }
  }
  const offstageFrames = deathFrame - startFrame

  // 4. Gates — every condition of a real edgeguard must hold.
  // (a) the victim actually attempted to recover
  if (recoveryFrame === null) return null
  // (a2) a kill straight up (non-offstage death) only counts when a forced
  //      onstage landing led into it — otherwise it's an air juggle, not an
  //      edgeguard. An offstage death needs no such proof.
  if (!diedOffstage && stageTouches < 1) return null
  // (b) they were within *their character's* recovery range of the ledge (not
  //     dying way out beyond what they could ever recover from). `inRange` is
  //     computed above the loop — the denial test uses it per-frame too.
  if (minLedgeDist > inRange) return null
  // (c) the edgeguarder blocked the return AFTER the attempt
  const ledgeStealBlocks = ledgeSteal && opts.includeLedgeSteals
  if (!blockedByHit && !ledgeStealBlocks) return null
  // (d) sequence length / commit knobs
  if (offstageFrames < opts.minOffstageFrames) return null

  // Clip start = the FIRST FRAME OF THE ATTACKER'S MOVE that knocks the victim
  // offstage. Steps: (1) find the first frame the victim crosses offstage; (2)
  // the most recent frame their PERCENT went up at/before it — the exact frame
  // the connecting hit landed (percent, not hitstun edges, isolates the specific
  // knock-off hit out of a combo); (3) back up to the start of the edgeguarder's
  // move that landed it — walk back while the edgeguarder stays in the same
  // action state (the attack), so the clip opens as they begin the move, not
  // mid-swing. Capped so a non-attack state (e.g. a stray laser, edgeguarder in
  // Wait) can't drag the start back arbitrarily.
  let firstOff = startFrame
  for (let f = startFrame; f < deathFrame; f += 1) {
    const s = sample(frames, f, victimIdx)
    if (s && isOffstageStrict(s, side, stageEnd, edge)) {
      firstOff = f
      break
    }
  }
  // The connecting hit must lie WITHIN this edgeguard's own launch window
  // [startFrame, firstOff] — never before it. startFrame is where the victim
  // entered the non-recovered run (the walk-back stopped at the previous
  // recovery), so a percent rise here is the hit that launched THIS sequence.
  // Searching further back (to lookbackFloor) would cross a prior recovery —
  // e.g. a ledge grab — and anchor the clip to a stale, earlier hit, opening
  // the clip on a different exchange entirely (the bug that made a clip start
  // ~120 frames early, on the edgeguarder being comboed).
  let connectFrame: number | null = null
  for (let f = firstOff; f >= startFrame; f -= 1) {
    const cur = sample(frames, f, victimIdx)
    const prev = sample(frames, f - 1, victimIdx)
    if (cur && prev && cur.pct > prev.pct) {
      connectFrame = f // the frame the knock-off hit connected
      break
    }
  }
  // No hit at the launch = the victim entered this offstage run on their own
  // (left the ledge / drifted off after recovering), not knocked off it. They
  // recovered, so by definition this isn't an edgeguard — and "clips must START
  // with the hit that sends them offstage" can't be honoured without that hit.
  // Reject.
  if (connectFrame === null) return null
  let clipStart = connectFrame
  const egHit = sample(frames, connectFrame, edgeguarderIdx)
  if (egHit) {
    const startupFloor = Math.max(lookbackFloor, connectFrame - 45)
    while (clipStart > startupFloor) {
      const eprev = sample(frames, clipStart - 1, edgeguarderIdx)
      if (!eprev || eprev.a !== egHit.a) break // left the attack's action state
      clipStart -= 1
    }
  }
  // Lead-in: open the clip a configurable number of frames before the move
  // begins (a beat of lead-up). Bounded by the floor so it can't reach back
  // across the edgeguarder's own death/respawn/recovery.
  clipStart = Math.max(clipStart - opts.leadInFrames, lookbackFloor)

  // Final-hit-to-death gap, and whether the edgeguarder finished back onstage.
  const lastHitToDeath = lastHitFrame === null ? -1 : deathFrame - lastHitFrame
  const endE = sample(frames, deathFrame - 1, edgeguarderIdx)
  const edgeguarderReturned = endE
    ? Math.abs(endE.x) < stageEnd && endE.y >= edge.yMin
    : false

  // Interestingness score from the DISCRIMINATIVE metrics. The old formula
  // leaned on saturated signals (ledgeSteal near-constant)
  // and victim death-geometry (maxDepthX/minY), which selected for blowouts —
  // victims flung to the far corner, the opposite of a contest. This rewards:
  //   - the back-and-forth (recoveryAttempts), the single strongest signal
  //   - the forced-landing read (stageTouches): ledge covered, onstage landing
  //     punished back off — premium, rare, high-skill
  //   - clutch denial right at the ledge (continuous, peaks at the ledge)
  //   - the edgeguarder's own risk/style (depth + surviving a deep commit)
  //   - a clean putaway (final hit kills) over a lingering flail
  // hits is kept but small — it correlates with attempts and saturates alone.
  // Weights re-tuned 2026-07-11 against 757 real clips (see the measured
  // distributions in each comment) — the previous cutoffs were set before the
  // parser's output was cleaned up, and two terms had gone effectively dead.
  //
  // clutch: minLedgeDist runs p25 7.1 / p50 13.8 / p75 21.8. The old
  // `max(0, 12 - mld)` cut off right AT the median, so 56% of clips tied at 0
  // and it could only rank the closest half. Spanning 30 keeps the same 0..12
  // range but discriminates across the whole population.
  const clutch = Math.max(0, 30 - minLedgeDist) * 0.4 // 0..12, peaks at the ledge
  // cleanRead: a final hit that kills promptly, vs a lingering flail.
  // lastHitToDeath runs p10 29 / p25 51 / p50 85 — an offstage victim needs
  // time to FALL to the blastzone after the last hit, so the old `< 20` fired on
  // just 4% of clips (corr 0.07 with the score — noise). 45 is just under p25:
  // the fastest ~20% of putaways. (-1 = no hit landed at all; guard stays.)
  const cleanRead = lastHitToDeath >= 0 && lastHitToDeath < 45 ? 3 : 0
  const returnBonus = edgeguarderReturned && edgeguarderDepth > 30 ? 5 : 0
  const forcedLanding = stageTouches * 5 // option-coverage read, rare + premium
  const score =
    recoveryAttempts * 6 +
    forcedLanding +
    clutch +
    // depth is THE commitment metric now (it replaced the saturated binary
    // edgeguarderOffstage), so it carries more weight than it used to (/10).
    edgeguarderDepth / 6 +
    returnBonus +
    cleanRead +
    Math.min(hits, 4) * 1.5

  return {
    startFrame: clipStart,
    endFrame: deathFrame,
    metrics: {
      offstageFrames,
      hits,
      recoveryFrame,
      minLedgeDist,
      blockedByHit,
      ledgeSteal,
      maxDepthX,
      minY,
      recoveryAttempts,
      edgeguarderDepth,
      edgeguarderReturned,
      lastHitToDeath,
      stageTouches,
      diedOffstage,
      score,
    },
  }
}

// Latest stock-spawn frame for a player at/before `atFrame` — when they last
// came alive. Used to bound an exchange to the span both players are live, so a
// clip never reaches back across a respawn or a prior KO.
function currentStockStart(
  stocks: StockType[],
  playerIndex: number,
  atFrame: number,
): number {
  let best = -Infinity
  for (const s of stocks) {
    const st = s.startFrame
    if (
      s.playerIndex == playerIndex &&
      st != null &&
      st <= atFrame &&
      st > best
    )
      best = st
  }
  return best
}

export default (
  prevResults: (FileInterface | ClipInterface)[],
  params: EdgeguardParams,
  _eventEmitter: EventEmitterInterface,
) => {
  const results: ClipInterface[] = []
  const {
    comboerChar,
    comboeeChar,
    comboerTag,
    comboeeTag,
    comboerCC,
    comboeeCC,
    stageFilter,
  } = params

  // How far inside the ledge "offstage" begins. Everything else about the
  // stage comes from Melee's own geometry.
  const bufferRaw = Number(params.offstageBuffer)
  const offstageBuffer = Number.isFinite(bufferRaw)
    ? bufferRaw
    : DEFAULT_OFFSTAGE_BUFFER

  const leniencyPct = parseInt(params.rangeLeniency ?? '', 10)
  const opts: DetectOpts = {
    minOffstageFrames: parseInt(params.minOffstageFrames ?? '', 10) || 20,
    rangeLeniency: (Number.isNaN(leniencyPct) ? 100 : leniencyPct) / 100,
    includeLedgeSteals: params.includeLedgeSteals !== false,
    maxLookbackFrames: parseInt(params.maxLookbackFrames ?? '', 10) || 600,
    maxActionableFrames: parseInt(params.maxActionableFrames ?? '', 10) || 0,
    leadInFrames: Number.isNaN(parseInt(params.leadInFrames ?? '', 10))
      ? 30
      : parseInt(params.leadInFrames ?? '', 10),
  }

  for (const item of prevResults) {
    const { path, players, stage } = item

    if (!matchesAny(stage, stageFilter)) continue

    const stageRects = edgeguardRects(stage, offstageBuffer)
    if (!stageRects) continue

    let game: SlippiGame
    let stocks: StockType[]
    let frames: ReturnType<SlippiGame['getFrames']>
    try {
      game = new SlippiGame(path)
      // Stocks-only: skip the 5 stat computers + overall stats getStats() would
      // otherwise run on every frame (we only need death frames here).
      stocks = computeStocks(game)
      frames = game.getFrames()
    } catch (e) {
      continue
    }
    if (!stocks.length) continue

    if ('combo' in item && item.combo) {
      const { comboer, comboee } = item
      if (!comboer || !comboee) continue
      if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC)) continue
      if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC)) continue

      // The combo's victim must die at/after the clip end.
      const clipEnd = item.endFrame
      const matchingStock = stocks
        .filter(
          (s) =>
            s.playerIndex == comboee.playerIndex &&
            s.endFrame != null &&
            s.endFrame >= clipEnd,
        )
        .sort((a, b) => (a.endFrame ?? 0) - (b.endFrame ?? 0))[0]
      if (!matchingStock) continue

      const exchangeFloor = Math.max(
        matchingStock.startFrame ?? -Infinity,
        currentStockStart(
          stocks,
          comboer.playerIndex,
          matchingStock.endFrame as number,
        ),
      )
      const eg = detectEdgeguard(
        matchingStock,
        comboee.playerIndex,
        comboee.characterId,
        comboer.playerIndex,
        frames,
        stageRects,
        opts,
        exchangeFloor,
      )
      if (eg) {
        results.push({
          ...item,
          startFrame: eg.startFrame,
          endFrame: eg.endFrame,
          edgeguardScore: eg.metrics.score,
          edgeguardMetrics: eg.metrics,
        })
      }
    } else {
      // Files mode: scan every stock; the victim is whoever lost the stock.
      if (!players) continue
      for (const stock of stocks) {
        if (stock.endFrame == null) continue
        const comboer = players.find(
          (p: PlayerInterface) => p.playerIndex != stock.playerIndex,
        )
        const comboee = players.find(
          (p: PlayerInterface) => p.playerIndex == stock.playerIndex,
        )
        if (!comboer || !comboee) continue
        if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC))
          continue
        if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC))
          continue

        const exchangeFloor = Math.max(
          stock.startFrame ?? -Infinity,
          currentStockStart(
            stocks,
            comboer.playerIndex,
            stock.endFrame as number,
          ),
        )
        const eg = detectEdgeguard(
          stock,
          comboee.playerIndex,
          comboee.characterId,
          comboer.playerIndex,
          frames,
          stageRects,
          opts,
          exchangeFloor,
        )
        if (eg) {
          // Drop the source row's `id`: on a FileInterface it's a string, while
          // a clip's `id` is the numeric SQLite rowid that Archive.parseRows
          // assigns at READ time. Carrying it through would put a string into a
          // numeric field (tsc caught this) and it gets overwritten anyway.
          const { id: _srcId, ...srcFields } = item
          results.push({
            ...srcFields,
            startFrame: eg.startFrame,
            endFrame: eg.endFrame,
            comboer,
            comboee,
            edgeguardScore: eg.metrics.score,
            edgeguardMetrics: eg.metrics,
          })
        }
      }
    }
  }

  return results
}
