/* eslint-disable eqeqeq */
import { SlippiGame, StockType } from '@slippi/slippi-js'
import { computeStocks } from '../../lib/slippiStocks'
import matchesAny from './matchesAny'
import { matchesPlayer } from '../../lib/filterHelpers'
import {
  FileInterface,
  ClipInterface,
  PressureParams,
  EventEmitterInterface,
  PlayerInterface,
} from '../../constants/types'

// "Pressure" = an EXTENDED ADVANTAGE state: one player attacks relentlessly in
// close range while the other is on the back foot — shielding, getting hit,
// scrambling, dodging — sustained over a long span, and eventually cracking the
// defender OPEN (a hit/grab) or getting the kill. Unlike a pure combo reel, it
// must build real shield contact along the way; unlike pure shield camping, the
// hits/conversions are welcomed — they're what string a long sequence together.

function inRange(a: number, lo: number, hi: number): boolean {
  return a >= lo && a <= hi
}

const DAMAGE_FALL = 0x26 // tumble after knockback

// Defender is shielding (GuardOn..GuardReflect) — the signature of shield pressure.
function isShielding(a: number): boolean {
  return inRange(a, 0xb2, 0xb6)
}

// Defender is scrambling but actionable: rolls / spotdodge / airdodge,
// knockdown + tech/getup, ledge hang.
function isScrambling(a: number): boolean {
  return (
    inRange(a, 0xe9, 0xec) || inRange(a, 0xb7, 0xcc) || inRange(a, 0xfc, 0xfd)
  )
}

// Defender is in hitstun — getting hit. In the extended-advantage model this is
// the attacker WINNING (part of the relentless flow), not disqualifying.
function isHitstun(a: number): boolean {
  return inRange(a, 0x4b, 0x61) || a === DAMAGE_FALL
}

// Attacker is applying offense (attacks / grabs / specials).
function isOffense(a: number): boolean {
  return inRange(a, 0x2c, 0x45) || inRange(a, 0xd4, 0xdf) || a >= 341
}

// Attacker is grabbing — a strong "opening" when it lands on a shielding foe.
function isGrab(a: number): boolean {
  return inRange(a, 0xd4, 0xdf)
}

type Sample = { x: number; y: number; a: number }

function sample(
  frames: Record<string, any>,
  frame: number,
  idx: number,
): Sample | null {
  const p = frames[frame]?.players?.[idx]?.post
  if (!p) return null
  return { x: p.positionX, y: p.positionY, a: p.actionStateId }
}

export type PressureMetrics = {
  durationFrames: number
  shieldHits: number // attacks landed into the shield
  shieldFrames: number
  scrambleFrames: number
  hitstunFrames: number
  openings: number // times the pressure cracked into a hit or grab
  hadOpening: boolean
  peakEval: number
  avgEval: number
  endedInKill: boolean
  score: number
}

type Detection = {
  startFrame: number
  endFrame: number
  metrics: PressureMetrics
}

type Opts = {
  threshold: number
  minDurationFrames: number
  smoothingWindow: number
  maxDipFrames: number
  closeRange: number
  offenseWeight: number
  shieldWeight: number
  hitstunWeight: number
  proximityWeight: number
  openingBonus: number
  minShieldHits: number
  requireKill: boolean
  killBonus: number
}

// Frames of lead-in / lead-out so the clip opens just before pressure ramps up
// and doesn't cut off the instant it ends.
const LEAD_IN_FRAMES = 24
const LEAD_OUT_FRAMES = 30
// A stock ending within this many frames of a stretch counts as ending in a kill.
const KILL_WINDOW = 30
// How far past the stretch to look for / show the opening payoff.
const OPENING_WINDOW = 45
// Scrambling (dodging/teching) is worth this fraction of a held shield.
const SCRAMBLE_FACTOR = 0.5

function detectPressure(
  attackerIdx: number,
  defenderIdx: number,
  frameKeys: number[],
  frames: Record<string, any>,
  stocks: StockType[],
  opts: Opts,
): Detection[] {
  const n = frameKeys.length

  // 1. Per-frame "advantage" eval: the attacker relentlessly attacking close
  //    while the defender is on the back foot (shield / hitstun / scramble).
  const raw = new Array<number>(n).fill(0)
  const shieldArr = new Array<boolean>(n).fill(false)
  const scrambleArr = new Array<boolean>(n).fill(false)
  const hitstunArr = new Array<boolean>(n).fill(false)
  const hitOnShield = new Array<boolean>(n).fill(false)
  const grabClose = new Array<boolean>(n).fill(false)

  for (let i = 0; i < n; i += 1) {
    const f = frameKeys[i]
    const A = sample(frames, f, attackerIdx)
    const D = sample(frames, f, defenderIdx)
    if (!A || !D) continue
    const dist = Math.hypot(A.x - D.x, A.y - D.y)
    const close = dist < opts.closeRange
    const aggressive = close && isOffense(A.a) // the relentless attacker

    let e = 0
    if (aggressive) e += opts.offenseWeight

    if (isShielding(D.a)) {
      shieldArr[i] = true
      e += opts.shieldWeight
      if (aggressive) hitOnShield[i] = true // a hit on the shield
    } else if (isHitstun(D.a)) {
      hitstunArr[i] = true
      e += opts.hitstunWeight // defender getting hit = attacker winning
    } else if (isScrambling(D.a)) {
      scrambleArr[i] = true
      e += opts.shieldWeight * SCRAMBLE_FACTOR
    }

    if (close && isGrab(A.a)) grabClose[i] = true
    if (close) e += opts.proximityWeight

    raw[i] = e > 10 ? 10 : e
  }

  // 2. Smooth into a curve so it stays elevated across the natural ebbs of a
  //    long exchange (a bigger window = longer, more-prolonged clips).
  const W = Math.max(1, opts.smoothingWindow)
  const sm = new Array<number>(n).fill(0)
  let acc = 0
  for (let i = 0; i < n; i += 1) {
    acc += raw[i]
    if (i >= W) acc -= raw[i - W]
    sm[i] = acc / Math.min(i + 1, W)
  }

  // 3. Collect contiguous stretches at/above threshold (tolerating brief dips).
  const out: Detection[] = []
  let i = 0
  while (i < n) {
    if (sm[i] < opts.threshold) {
      i += 1
      continue
    }
    const start = i
    let lastGood = i
    let dip = 0
    let j = i + 1
    for (; j < n; j += 1) {
      if (sm[j] >= opts.threshold) {
        lastGood = j
        dip = 0
      } else {
        dip += 1
        if (dip > opts.maxDipFrames) break
      }
    }

    const startF = frameKeys[start]
    const durationFrames = frameKeys[lastGood] - startF

    if (durationFrames >= opts.minDurationFrames) {
      let peakEval = 0
      let sum = 0
      let shieldFrames = 0
      let scrambleFrames = 0
      let hitstunFrames = 0
      let shieldHits = 0
      let prevHit = false
      for (let k = start; k <= lastGood; k += 1) {
        if (sm[k] > peakEval) peakEval = sm[k]
        sum += sm[k]
        if (shieldArr[k]) shieldFrames += 1
        if (scrambleArr[k]) scrambleFrames += 1
        if (hitstunArr[k]) hitstunFrames += 1
        if (hitOnShield[k] && !prevHit) shieldHits += 1
        prevHit = hitOnShield[k]
      }
      const avgEval = sum / (lastGood - start + 1)

      // Openings: the shield/scramble cracking into a hit or grab.
      let openings = 0
      const openEnd = Math.min(n - 1, lastGood + OPENING_WINDOW)
      for (let k = start + 1; k <= openEnd; k += 1) {
        const wasPressured = shieldArr[k - 1] || scrambleArr[k - 1]
        if (wasPressured && hitstunArr[k]) openings += 1
        if (wasPressured && grabClose[k]) openings += 1
      }
      const hadOpening = openings > 0

      const death = stocks.find(
        (s) =>
          s.playerIndex == defenderIdx &&
          s.endFrame != null &&
          s.endFrame >= startF &&
          s.endFrame <= frameKeys[lastGood] + KILL_WINDOW,
      )
      const endedInKill = !!death

      // Keep it only if it built real shield contact AND cracked the defender
      // open (a hit/grab) or got the kill — "attack relentlessly, get an
      // opening eventually". A pure juggle has shieldHits 0 and is dropped.
      if (
        shieldHits >= opts.minShieldHits &&
        (hadOpening || endedInKill) &&
        (!opts.requireKill || endedInKill)
      ) {
        // End at the kill, else the opening payoff, plus a lead-out tail.
        let endF = frameKeys[Math.min(n - 1, lastGood + LEAD_OUT_FRAMES)]
        if (death && death.endFrame != null) endF = death.endFrame
        else if (hadOpening) endF = frameKeys[openEnd]

        // Reward LENGTH (relentlessness) + shield contact + the payoff.
        const score =
          durationFrames / 45 +
          shieldHits +
          openings * opts.openingBonus +
          (endedInKill ? opts.killBonus : 0)

        out.push({
          startFrame: Math.max(frameKeys[0], startF - LEAD_IN_FRAMES),
          endFrame: endF,
          metrics: {
            durationFrames,
            shieldHits,
            shieldFrames,
            scrambleFrames,
            hitstunFrames,
            openings,
            hadOpening,
            peakEval,
            avgEval,
            endedInKill,
            score,
          },
        })
      }
    }

    i = Math.max(j, lastGood + 1)
  }

  return out
}

export default (
  prevResults: (FileInterface | ClipInterface)[],
  params: PressureParams,
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

  const num = (v: string | undefined, d: number): number => {
    const parsed = parseInt(v ?? '', 10)
    return Number.isNaN(parsed) ? d : parsed
  }

  const opts: Opts = {
    threshold: num(params.threshold, 5),
    minDurationFrames: num(params.minDurationFrames, 200),
    smoothingWindow: num(params.smoothingWindow, 60),
    maxDipFrames: num(params.maxDipFrames, 70),
    closeRange: num(params.closeRange, 40),
    offenseWeight: num(params.offenseWeight, 4),
    shieldWeight: num(params.shieldWeight, 3),
    hitstunWeight: num(params.hitstunWeight, 3),
    proximityWeight: num(params.proximityWeight, 1),
    openingBonus: num(params.openingBonus, 5),
    minShieldHits: num(params.minShieldHits, 2),
    requireKill: !!params.requireKill,
    killBonus: num(params.killBonus, 5),
  }

  for (const item of prevResults) {
    const { path, players, stage } = item

    if (!matchesAny(stage, stageFilter)) continue

    let game: SlippiGame
    let frames: ReturnType<SlippiGame['getFrames']>
    let stocks: StockType[]
    try {
      game = new SlippiGame(path)
      frames = game.getFrames()
      stocks = computeStocks(game)
    } catch (e) {
      continue
    }

    const frameKeys = Object.keys(frames)
      .map(Number)
      .sort((a, b) => a - b)
    if (!frameKeys.length) continue

    // Resolve (attacker, defender) pairs. In combo mode the pair is fixed; in
    // files mode every player is a candidate attacker (the char/tag filters
    // below pick out who you're after).
    const pairs: { attacker: PlayerInterface; defender: PlayerInterface }[] = []
    if ('combo' in item && item.combo) {
      const { comboer, comboee } = item
      if (comboer && comboee)
        pairs.push({ attacker: comboer, defender: comboee })
    } else if (players) {
      for (const attacker of players) {
        const defender = players.find(
          (p: PlayerInterface) => p.playerIndex != attacker.playerIndex,
        )
        if (defender) pairs.push({ attacker, defender })
      }
    }

    for (const { attacker, defender } of pairs) {
      if (!matchesPlayer(attacker, comboerChar, comboerTag, comboerCC)) continue
      if (!matchesPlayer(defender, comboeeChar, comboeeTag, comboeeCC)) continue

      const stretches = detectPressure(
        attacker.playerIndex,
        defender.playerIndex,
        frameKeys,
        frames,
        stocks,
        opts,
      )
      for (const s of stretches) {
        // Drop the source row's `id` — see the same note in edgeguard.ts: a
        // FileInterface id is a string, a clip id is the numeric rowid assigned
        // at read time.
        const { id: _srcId, ...srcFields } = item
        results.push({
          ...srcFields,
          startFrame: s.startFrame,
          endFrame: s.endFrame,
          comboer: attacker,
          comboee: defender,
          pressureScore: s.metrics.score,
          pressureMetrics: s.metrics,
        })
      }
    }
  }

  return results
}
