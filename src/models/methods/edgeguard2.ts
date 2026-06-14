/* eslint-disable eqeqeq */
import { SlippiGame, StockType } from '@slippi/slippi-js'
import rectangles from '../../constants/rectangles'
import { computeStocks } from '../../lib/slippiStocks'
import { getRecoveryRange } from '../../constants/recoveryData'
import matchesAny from './matchesAny'
import { matchesPlayer } from '../../lib/filterHelpers'
import {
  FileInterface,
  ClipInterface,
  Edgeguard2Params,
  EventEmitterInterface,
  PlayerInterface,
} from '../../constants/types'

// Hitstun / knockback action states (DamageHi/N/Lw/Fly...). Being in one of
// these = the player is getting hit.
const damageStates = new Set([
  0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57,
  0x58, 0x59, 0x5a, 0x5b,
])

// Universal action states for ledge occupation (taking the ledge to deny a
// recovery — the core of a no-contact "ledge-steal" edgeguard).
const CLIFF_CATCH = 0xfc
const CLIFF_WAIT = 0xfd

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

// Frames of lead-in before the launching hit so the clip opens with the hit
// visibly connecting rather than mid-knockback.
const LEAD_IN_FRAMES = 8

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

// Is the victim out in the offstage/edge region on the side they died on?
// "Offstage" = past the inner ledge boundary horizontally, or below the stage
// lip. edge.xMin is the inner (stageward) edge of the ledge band.
function isOffstage(s: Sample, side: Side, edge: Rect): boolean {
  const onDeathSide = side === 'right' ? s.x > 0 : s.x < 0
  if (!onDeathSide) return false
  return Math.abs(s.x) > edge.xMin || s.y < edge.yMin
}

export type EdgeguardMetrics = {
  offstageFrames: number
  hits: number
  recoveryFrame: number | null
  minLedgeDist: number
  blockedByHit: boolean
  ledgeSteal: boolean
  edgeguarderOffstage: boolean
  maxDepthX: number
  minY: number
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
  requireEdgeguarderCommit: boolean
  includeLedgeSteals: boolean
  maxLookbackFrames: number
}

function detectEdgeguard(
  stock: { endFrame: number | null },
  victimIdx: number,
  victimCharId: number,
  edgeguarderIdx: number,
  frames: Record<string, any>,
  rects: { bz: Rect; edge: Rect },
  opts: DetectOpts,
): Detection | null {
  if (stock.endFrame == null) return null
  const deathFrame = stock.endFrame

  const { edge } = rects

  // 1. KO gate. A real edgeguard ends in a blastzone death while the victim is
  //    offstage — out the SIDE or off the BOTTOM (a spike / meteor smash). We
  //    reject only top-blastzone deaths, which come from juggles, not
  //    edgeguards. (On solid-ground legal stages you can only die off the
  //    bottom by being offstage past a ledge anyway, so this stays precise.)
  const death = sample(frames, deathFrame - 1, victimIdx)
  if (!death) return null
  const side: Side = death.x >= 0 ? 'right' : 'left'
  if (death.y >= rects.bz.yMax) return null // off the top = not an edgeguard
  if (!isOffstage(death, side, edge)) return null // must die offstage, not on stage

  // The ledge point on the death side — used to measure whether the victim was
  // ever within recovery range. edge.xMax is the outer (ledge-tip) boundary.
  const ledgeX = side === 'right' ? edge.xMax : -edge.xMax
  const ledgeY = 0

  // 2. Walk back from the KO to the start of the final offstage trip — the
  //    last frame the victim was safely onstage. The clip captures the whole
  //    knocked-off -> dead arc.
  let startFrame = deathFrame - 1
  const lookbackFloor = deathFrame - 1 - opts.maxLookbackFrames
  for (let cf = deathFrame - 1; cf > lookbackFloor; cf -= 1) {
    const s = sample(frames, cf, victimIdx)
    if (!s || !isOffstage(s, side, edge)) break
    startFrame = cf
  }

  // 3. Single pass over the offstage window, reconstructing the sequence:
  //    recovery attempt -> in-range -> block-after-attempt -> death.
  let recoveryFrame: number | null = null
  let minLedgeDist = Infinity
  let hits = 0
  let prevDmg = false
  let blockedByHit = false // a hit that landed AFTER the recovery attempt
  let ledgeSteal = false // edgeguarder on the ledge AFTER the recovery attempt
  let edgeguarderOffstage = false
  let maxDepthX = 0
  let minY = Infinity

  for (let f = startFrame; f < deathFrame; f += 1) {
    const v = sample(frames, f, victimIdx)
    if (v) {
      const offstage = isOffstage(v, side, edge)

      // Recovery attempt: first time offstage the victim uses a recovery move.
      if (recoveryFrame === null && offstage && isRecoveryMove(v.a)) {
        recoveryFrame = f
      }

      // In-range: closest the victim got to the ledge while offstage.
      if (offstage) {
        const dist = Math.hypot(v.x - ledgeX, v.y - ledgeY)
        if (dist < minLedgeDist) minLedgeDist = dist
      }

      // Hits on the victim. A hit landed after the recovery attempt = the
      // edgeguarder blocking the return.
      const dmg = damageStates.has(v.a)
      if (dmg && !prevDmg) {
        hits += 1
        if (recoveryFrame !== null && f > recoveryFrame) blockedByHit = true
      }
      prevDmg = dmg

      maxDepthX = Math.max(maxDepthX, Math.abs(v.x))
      minY = Math.min(minY, v.y)
    }

    const e = sample(frames, f, edgeguarderIdx)
    if (e) {
      const onDeathSide = side === 'right' ? e.x > 0 : e.x < 0
      if (onDeathSide && Math.abs(e.x) > edge.xMin) edgeguarderOffstage = true
      // Ledge-steal block: edgeguarder occupying the ledge after the victim
      // committed to a recovery (they can't grab an occupied ledge).
      if (
        onDeathSide &&
        (e.a === CLIFF_CATCH || e.a === CLIFF_WAIT) &&
        recoveryFrame !== null &&
        f >= recoveryFrame
      ) {
        ledgeSteal = true
      }
    }
  }
  const offstageFrames = deathFrame - startFrame

  // 4. Gates — all four conditions of a real edgeguard must hold.
  // (a) the victim actually attempted to recover
  if (recoveryFrame === null) return null
  // (b) they were within *their character's* recovery range of the ledge (not
  //     dying way out beyond what they could ever recover from)
  const inRange = getRecoveryRange(victimCharId) * opts.rangeLeniency
  if (minLedgeDist > inRange) return null
  // (c) the edgeguarder blocked the return AFTER the attempt
  const ledgeStealBlocks = ledgeSteal && opts.includeLedgeSteals
  if (!blockedByHit && !ledgeStealBlocks) return null
  // (d) sequence length / commit knobs
  if (offstageFrames < opts.minOffstageFrames) return null
  if (opts.requireEdgeguarderCommit && !edgeguarderOffstage) return null

  // Clip start = the hit that sent them offstage. Walk back from the first
  // offstage frame through the continuous hitstun that launched them, then add
  // a short lead-in so the hit is visible connecting.
  let clipStart = startFrame
  while (clipStart > lookbackFloor) {
    const prev = sample(frames, clipStart - 1, victimIdx)
    if (!prev || !damageStates.has(prev.a)) break
    clipStart -= 1
  }
  clipStart = Math.max(clipStart - LEAD_IN_FRAMES, lookbackFloor)

  // Heuristic score for downstream sorting: reward multi-hit, drawn-out, deep
  // sequences where the edgeguarder committed offstage.
  const depthFactor = minY < 0 ? Math.min(Math.abs(minY) / 100, 2) : 0
  const score =
    hits * 3 +
    offstageFrames / 30 +
    (edgeguarderOffstage ? 4 : 0) +
    (ledgeSteal ? 2 : 0) +
    maxDepthX / 50 +
    depthFactor

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
      edgeguarderOffstage,
      maxDepthX,
      minY,
      score,
    },
  }
}

export default (
  prevResults: (FileInterface | ClipInterface)[],
  params: Edgeguard2Params,
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

  const leniencyPct = parseInt(params.rangeLeniency ?? '', 10)
  const opts: DetectOpts = {
    minOffstageFrames: parseInt(params.minOffstageFrames ?? '', 10) || 20,
    rangeLeniency: (Number.isNaN(leniencyPct) ? 100 : leniencyPct) / 100,
    requireEdgeguarderCommit: !!params.requireEdgeguarderCommit,
    includeLedgeSteals: params.includeLedgeSteals !== false,
    maxLookbackFrames: parseInt(params.maxLookbackFrames ?? '', 10) || 600,
  }

  for (const item of prevResults) {
    const { path, players, stage } = item

    if (!matchesAny(stage, stageFilter)) continue

    const stageRects = rectangles[stage]
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

    const isClipMode = !!item.combo

    if (isClipMode) {
      const { comboer, comboee } = item
      if (!comboer || !comboee) continue
      if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC)) continue
      if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC)) continue

      // The combo's victim must die at/after the clip end.
      const clipEnd = parseInt(item.endFrame, 10)
      const matchingStock = stocks
        .filter(
          (s) =>
            s.playerIndex == comboee.playerIndex &&
            s.endFrame != null &&
            s.endFrame >= clipEnd,
        )
        .sort((a, b) => (a.endFrame ?? 0) - (b.endFrame ?? 0))[0]
      if (!matchingStock) continue

      const eg = detectEdgeguard(
        matchingStock,
        comboee.playerIndex,
        comboee.characterId,
        comboer.playerIndex,
        frames,
        stageRects,
        opts,
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

        const eg = detectEdgeguard(
          stock,
          comboee.playerIndex,
          comboee.characterId,
          comboer.playerIndex,
          frames,
          stageRects,
          opts,
        )
        if (eg) {
          results.push({
            ...item,
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
