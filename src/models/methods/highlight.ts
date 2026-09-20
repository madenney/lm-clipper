/* eslint-disable eqeqeq */
/*
 * ============================================================================
 * TOURNAMENT HIGHLIGHT FINDER (highlight) — how it works, in plain English
 * ============================================================================
 *
 * GOAL
 *   Surface the moments a crowd/stream would react to — not just "big numbers".
 *   The existing parsers are single-dimension threshold detectors (a combo is
 *   N+ hits, an edgeguard clears cutoffs). This one scores every candidate
 *   moment on a blend of signals and ranks them, so the top clips of a ~100-game
 *   tournament pile are the genuinely interesting ones across ALL flavors:
 *     - HYPE / COMEBACK — a big swing in who's winning (the intelligent core)
 *     - CLUTCH          — last-stock / close-game stakes, resolved decisively
 *     - SKILL           — sick combos, 0-to-deaths, gimps (reuses combo/stage data)
 *     - CHAOS           — SDs, trades/double-KOs, disrespect
 *
 * ANCHORING
 *   Almost every highlight culminates in a stock being taken, so we anchor a
 *   candidate moment on each DEATH. The clip is bounded from the start of the
 *   killing exchange (with a lead-in) to just after the KO.
 *
 * THE INTELLIGENT CORE — a Melee win-probability proxy
 *   Each player's "life" is  effStocks = stocksRemaining - min(percent/150, ~1).
 *   winProb(killer) = logistic(K * (effStocks_killer - effStocks_victim)).
 *   A death's SWING = winProb_after - winProb_before: a stock taken while
 *   already winning is a small swing; a stock that claws a losing player back is
 *   a big one. We also track each player's LOWEST win-prob so far, so the death
 *   that completes a comeback (down 3-1, storms back) scores its full arc, not
 *   just the last exchange. This is what thresholds are blind to.
 *
 * SCORING
 *   score = swing + comeback-arc + stakes + spectacle + chaos + intensity,
 *   each a named, tunable weight (see WEIGHTS). Every kept clip carries
 *   `highlightScore`, the full `highlightMetrics`, and a `flavors` list (which
 *   signals fired) so a downstream Sort ranks them and a montage can pull just
 *   the comebacks / chaos / etc.
 *
 * CALIBRATION (v1 honesty)
 *   The win-prob curve and the weights are reasonable first guesses. The plan is
 *   to hand-rate a sample of real tournament clips and tune them — the same
 *   "measure, don't guess" path the edgeguard scorer took (757 clips). Until
 *   then, treat the ranking as good-not-gospel.
 *
 * Files mode only: reads each .slp once via getStats() (affordable at ~100
 * games) and emits scored clips. Optional killer/victim char/tag/CC filters.
 * ============================================================================
 */
import { SlippiGame } from '@slippi/slippi-js'
import { moves as MOVE_LIST } from '../../constants/moves'
import { edgeguardRects } from '../../constants/stageGeometry'
import {
  ClipInterface,
  FileInterface,
  PlayerInterface,
  EventEmitterInterface,
} from '../../constants/types'

// --- Tunables (first-guess weights; calibrate against rated clips later) -----
const WP_K = 1.15 // logistic steepness on the effective-stock lead
const PCT_PER_STOCK = 150 // percent that ≈ one stock of "life" in the WP proxy
const DMG_WINDOW = 180 // lead-up window for damage-rate intensity (3s @ 60fps)
const SD_GAP = 90 // frames since last enemy hit that reads as a self-destruct
const TRADE_GAP = 8 // two deaths within this many frames = a trade / double-KO
const ZTD_START = 20 // a killing combo starting below this % is a "0-to-death"
const GIMP_MAX_PCT = 60 // an offstage death under this % reads as a (real) gimp
const BEHIND_WP = 0.38 // killer must have dipped below this win-prob for a comeback to count
const MAX_CLIP_FRAMES = 900 // default clip-length cap (15s); trims the FRONT
const SURVIVAL_MIN_PCT = 115 // a combo must reach this % for the escape to count
const SURVIVAL_RESET = 120 // survivor must live this many frames after (else it's a delayed kill) // prettier-ignore
const TENSION_WINDOW = 600 // lead-up window (10s) scanned for a both-high standoff
const TENSION_PCT = 85 // both players above this % = kill-percent, could-die-any-moment
const TENSION_CAP_SEC = 6 // both-high seconds past which the tension bonus saturates

// SPECTACLE-FIRST: on-screen action (combo damage/moves, gimps, 0-to-deaths) is
// the primary driver. Stakes/comeback are modifiers — a boring last-stock kill
// should NOT out-rank a sick midgame combo.
const WEIGHTS = {
  combo: 0.5, // per % of punish damage into the KO — the main driver
  moves: 3.0, // per move in the killing combo (capped)
  diversity: 3.5, // per DISTINCT move beyond 2 — combo-video variety, not 9 uptilts
  spike: 12, // the kill was a Down-air spike / meteor
  zeroToDeath: 14, // a REAL 0-to-death (multi-move, low→dead)
  gimp: 14, // a REAL gimp (deep offstage, low %)
  comeback: 60, // per unit of win-prob recovered — ONLY when genuinely behind
  swing: 12, // demoted: every kill has some, weak discriminator
  lastStock: 10, // game-ending stock (victim to 0)
  bothLastStock: 28, // BOTH on their final stock — game point both ways, peak hype
  killerLastStock: 12, // the winner was themselves on their last stock (clutch stand)
  tension: 26, // a sustained both-at-kill-% standoff (saturates at TENSION_CAP_SEC)
  closeGame: 6, // both players low on stocks
  sd: 6, // self-destruct
  trade: 8, // double-KO / trade
  disrespect: 5, // taunt near the kill
  intensity: 1.5, // per (%/sec) of lead-up damage rate (capped, small)
  survivalBase: 8, // just for surviving a lethal-percent combo
  survivalPeril: 22, // × how far past SURVIVAL_MIN_PCT the % got (capped)
  survivalEscape: 12, // survived it while offstage / in the corner
}

// Melee taunt / appeal action states (appeal L/R) — used for the disrespect nod.
const APPEAL_STATES = new Set([0x108, 0x109])

// Move-style signals (ids from constants/moves).
const SPIKE_MOVE = 17 // Down Air — meteor/spike kills pop off
const MOVE_NAME: Record<number, string> = {}
for (const m of MOVE_LIST as { id: number; name: string; shortName?: string }[])
  MOVE_NAME[m.id] = m.shortName || m.name

type HighlightParams = {
  comboerChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeChar?: (string | number)[]
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
  minScore?: string
  maxPerGame?: string
  leadInFrames?: string
  tailFrames?: string
  maxClipFrames?: string
  includeSurvivals?: boolean
}

export type HighlightMetrics = {
  score: number
  flavors: string[]
  winProbSwing: number
  comebackMagnitude: number
  killerWinProbAfter: number
  lastStock: boolean
  killerStocks: number
  victimStocksAfter: number
  comboDamage: number
  comboMoves: number
  isZeroToDeath: boolean
  isGimp: boolean
  isSD: boolean
  isTrade: boolean
  disrespect: boolean
  damageRate: number
  victimPercentAtDeath: number
  isSurvival: boolean
  perilPercent: number
  distinctMoves: number
  spikeKill: boolean
  killMove: string
  bothLastStock: boolean
  tensionSecs: number
  reason: string
}

// Seconds in the lead-up where BOTH players sat at kill percent — a "could die
// any second" standoff. This is the close-battle / high-tension signal.
function tensionSeconds(
  frames: any,
  aIdx: number,
  bIdx: number,
  atFrame: number,
): number {
  const start = Math.max(1, atFrame - TENSION_WINDOW)
  let both = 0
  for (let f = start; f <= atFrame; f += 3) {
    const pa = frames[f]?.players?.[aIdx]?.post?.percent
    const pb = frames[f]?.players?.[bIdx]?.post?.percent
    if (pa != null && pb != null && pa > TENSION_PCT && pb > TENSION_PCT)
      both += 3
  }
  return both / 60
}

// A short, human-readable "why this clip scored" — for eyeballing the ranking
// and montage sorting.
function buildReason(m: HighlightMetrics): string {
  const parts: string[] = []
  if (m.isSurvival) {
    parts.push(
      `survived a ${m.perilPercent}%${m.comboMoves >= 4 ? ` ${m.comboMoves}-hit` : ''} combo`,
    )
  } else if (m.isZeroToDeath) {
    parts.push(`${m.comboMoves}-hit ${m.comboDamage}% 0-to-death`)
  } else if (m.isGimp) {
    parts.push(`gimp at ${m.victimPercentAtDeath}%`)
  } else if (m.comboMoves >= 4) {
    parts.push(`${m.comboMoves}-hit ${m.comboDamage}% punish`)
  } else {
    parts.push(m.killMove || 'kill')
  }
  if (m.spikeKill && !m.isSurvival) parts.push('spike')
  if (m.distinctMoves >= 5) parts.push(`${m.distinctMoves} distinct moves`)
  const tags: string[] = []
  if (m.flavors.includes('comeback')) tags.push('comeback')
  if (m.bothLastStock) tags.push('game point both ways')
  else if (m.lastStock) tags.push('last stock')
  else if (m.killerStocks <= 1 && !m.isSurvival)
    tags.push('winner on last stock')
  if (m.tensionSecs >= 2) tags.push(`both at kill % for ${Math.round(m.tensionSecs)}s`) // prettier-ignore
  if (m.isTrade) tags.push('double KO')
  else if (m.isSD) tags.push('opponent SD')
  if (m.disrespect) tags.push('disrespect')
  let s = parts.join(', ')
  if (tags.length) s += ` — ${tags.join(', ')}`
  return s
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x))
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))

const effStocks = (stocks: number, percent: number) =>
  stocks - clamp(percent / PCT_PER_STOCK, 0, 0.99)

// Win probability for the killer given both players' effective stocks.
const winProb = (killerEff: number, victimEff: number) =>
  logistic(WP_K * (killerEff - victimEff))

const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v ? [String(v)] : []

function matchesPlayer(
  p: PlayerInterface,
  chars?: (string | number)[],
  tags?: string[] | string,
  ccs?: string[] | string,
): boolean {
  const cs = (Array.isArray(chars) ? chars : []).map((c) => Number(c))
  if (cs.length && !cs.includes(p.characterId)) return false
  const ts = asArr(tags)
  if (ts.length) {
    const names = [p.displayName, p.nametag].filter(Boolean).map(String)
    if (!ts.some((t) => names.includes(t))) return false
  }
  const cc = asArr(ccs)
  if (cc.length && !cc.includes(String(p.connectCode))) return false
  return true
}

// Stocks a player has remaining at a frame = the `count` of their active stock.
function stocksRemainingAt(
  stocks: any[],
  playerIndex: number,
  frame: number,
): number {
  for (const s of stocks) {
    if (s.playerIndex != playerIndex) continue
    const start = s.startFrame ?? -Infinity
    const end = s.endFrame ?? Infinity
    if (start <= frame && frame <= end) return s.count ?? 0
  }
  return 0
}

export default (
  prevResults: (FileInterface | ClipInterface)[],
  params: HighlightParams,
  _eventEmitter: EventEmitterInterface,
): ClipInterface[] => {
  const results: ClipInterface[] = []

  const minScore = parseFloat(params.minScore ?? '') || 0
  const maxPerGame = parseInt(params.maxPerGame ?? '', 10) || 0
  const leadIn = Number.isNaN(parseInt(params.leadInFrames ?? '', 10))
    ? 60
    : parseInt(params.leadInFrames ?? '', 10)
  const tail = Number.isNaN(parseInt(params.tailFrames ?? '', 10))
    ? 45
    : parseInt(params.tailFrames ?? '', 10)
  const maxClipFrames = Number.isNaN(parseInt(params.maxClipFrames ?? '', 10))
    ? MAX_CLIP_FRAMES
    : parseInt(params.maxClipFrames ?? '', 10)
  const includeSurvivals = params.includeSurvivals !== false

  // Cap clip length by trimming the FRONT so the moment still ends on the KO.
  const capStart = (startFrame: number, endFrame: number) =>
    maxClipFrames > 0 && endFrame - startFrame > maxClipFrames
      ? endFrame - maxClipFrames
      : startFrame

  for (const item of prevResults) {
    const { path } = item
    const players = (item as FileInterface).players
    if (!players || players.length !== 2) continue

    let game: SlippiGame
    let stats: any
    let frames: any
    let stage: number
    try {
      game = new SlippiGame(path)
      stats = game.getStats()
      frames = game.getFrames()
      stage = game.getSettings()?.stageId ?? (item as any).stage
    } catch {
      continue
    }
    if (!stats?.stocks?.length) continue

    const stocks = stats.stocks as any[]
    const conversions = (stats.conversions ?? []) as any[]
    const rects = edgeguardRects(stage)

    // Deaths in chronological order.
    const deaths = stocks
      .filter((s) => s.endFrame != null)
      .sort((a, b) => (a.endFrame ?? 0) - (b.endFrame ?? 0))

    // Running low-water win-prob per player, for the comeback arc.
    const minWP: Record<number, number> = {}
    for (const p of players) minWP[p.playerIndex] = 0.5

    // Source-file fields carried onto every clip (drop the row `id`: it's a
    // string here but a numeric SQLite rowid on a read clip).
    const { id: _srcId, ...srcFields } = item as any
    const candidates: ClipInterface[] = []

    for (const s of deaths) {
      const deathFrame = s.endFrame as number
      const victimIdx = s.playerIndex as number
      const killer = players.find((p) => p.playerIndex != victimIdx)
      const victim = players.find((p) => p.playerIndex == victimIdx)
      if (!killer || !victim) continue

      // --- Stock state around the death ---
      const victimStocksBefore = s.count ?? 1
      const victimStocksAfter = victimStocksBefore - 1
      const killerStocks = stocksRemainingAt(stocks, killer.playerIndex, deathFrame) // prettier-ignore
      const killerPct =
        frames[deathFrame]?.players?.[killer.playerIndex]?.post?.percent ?? 0
      const victimPct =
        frames[deathFrame - 1]?.players?.[victimIdx]?.post?.percent ??
        s.currentPercent ??
        0

      // --- Win-probability swing + comeback arc ---
      const killerEff = effStocks(killerStocks, killerPct)
      const wpBefore = winProb(killerEff, effStocks(victimStocksBefore, 0))
      const wpAfter = winProb(killerEff, effStocks(victimStocksAfter, 0))
      const swing = Math.max(0, wpAfter - wpBefore)
      // A REAL comeback only: the killer must have genuinely been losing (their
      // win-prob dipped below BEHIND_WP) earlier — not just "won a close game",
      // which taking the final stock always looks like.
      const killerLow = minWP[killer.playerIndex] ?? 0.5
      const comebackMagnitude =
        killerLow < BEHIND_WP ? Math.max(0, wpAfter - killerLow) : 0
      // Update low-water marks with the post-death state (killer up, victim down).
      minWP[killer.playerIndex] = Math.min(minWP[killer.playerIndex] ?? 0.5, wpAfter) // prettier-ignore
      minWP[victimIdx] = Math.min(minWP[victimIdx] ?? 0.5, 1 - wpAfter)

      // --- Killing combo (spectacle): the punish on the victim ending at the KO ---
      let killConv: any = null
      for (const c of conversions) {
        if (c.playerIndex != victimIdx) continue
        const cEnd = c.endFrame ?? c.startFrame ?? -Infinity
        if (cEnd > deathFrame + 2 || cEnd < deathFrame - 45) continue
        if (!killConv || cEnd > (killConv.endFrame ?? killConv.startFrame))
          killConv = c
      }
      const comboStart = killConv?.startPercent ?? victimPct
      const comboEndPct = killConv?.currentPercent ?? killConv?.endPercent ?? victimPct // prettier-ignore
      const comboDamage = Math.max(0, comboEndPct - comboStart)
      const comboMoves = killConv?.moves?.length ?? 0
      // A REAL 0-to-death: started low AND was a genuine multi-move string that
      // did serious damage — not a single low-% hit that happened to kill.
      const isZeroToDeath =
        !!killConv &&
        comboStart < ZTD_START &&
        comboMoves >= 4 &&
        comboDamage >= 55
      // Style: distinct moves (combo-video variety) + a spike (dair) kill.
      const killMoveId =
        killConv?.moves?.[killConv.moves.length - 1]?.moveId ?? 0
      const distinctMoves = killConv?.moves
        ? new Set(killConv.moves.map((mv: any) => mv.moveId)).size
        : 0
      const spikeKill = killMoveId === SPIKE_MOVE

      // --- Gimp: died offstage at a lowish percent ---
      const deathPos = frames[deathFrame - 1]?.players?.[victimIdx]?.post
      const offstage =
        !!rects &&
        !!deathPos &&
        (Math.abs(deathPos.positionX) > rects.stageEnd ||
          deathPos.positionY < rects.edge.yMin)
      const isGimp = offstage && victimPct < GIMP_MAX_PCT

      // --- SD: no recent damage from the killer before the death ---
      let lastHitFrame = -Infinity
      for (
        let f = deathFrame - 1;
        f >= deathFrame - SD_GAP - 30 && f > 0;
        f--
      ) {
        const cur = frames[f]?.players?.[victimIdx]?.post?.percent
        const prev = frames[f - 1]?.players?.[victimIdx]?.post?.percent
        if (cur != null && prev != null && cur > prev) {
          lastHitFrame = f
          break
        }
      }
      const isSD = deathFrame - lastHitFrame > SD_GAP

      // --- Trade / double-KO ---
      const isTrade = deaths.some(
        (d) =>
          d !== s &&
          d.playerIndex != victimIdx &&
          Math.abs((d.endFrame ?? 0) - deathFrame) <= TRADE_GAP,
      )

      // --- Disrespect: a taunt by the killer near the kill ---
      let disrespect = false
      for (let f = deathFrame - 120; f <= deathFrame + 60; f += 4) {
        const a = frames[f]?.players?.[killer.playerIndex]?.post?.actionStateId
        if (a != null && APPEAL_STATES.has(a)) {
          disrespect = true
          break
        }
      }

      // --- Intensity: damage taken by the victim over the lead-up window ---
      const winStart = Math.max(1, deathFrame - DMG_WINDOW)
      const pStart = frames[winStart]?.players?.[victimIdx]?.post?.percent ?? 0
      const damageRate = Math.max(0, victimPct - pStart) / (DMG_WINDOW / 60)

      // --- Stakes & tension ---
      const lastStock = victimStocksAfter <= 0
      const closeGame = killerStocks <= 2 && victimStocksBefore <= 2
      const killerOnLastStock = killerStocks <= 1
      const bothLastStock = killerOnLastStock && victimStocksBefore <= 1
      const tensionSecs = tensionSeconds(
        frames,
        victimIdx,
        killer.playerIndex,
        deathFrame,
      )

      // --- Composite score + flavors (SPECTACLE-FIRST) ---
      // The killing conversion can be split by slippi; the lead-up damage into
      // the KO is a truer measure of the punish, so drive spectacle off the
      // larger of the two.
      const leadDamage = Math.max(0, victimPct - pStart)
      const punishDamage = Math.max(comboDamage, leadDamage)
      const flavors: string[] = []
      let score = 0

      // 1) Spectacle — the primary driver.
      score += punishDamage * WEIGHTS.combo
      score += Math.min(comboMoves, 10) * WEIGHTS.moves
      score += Math.max(0, distinctMoves - 2) * WEIGHTS.diversity
      if (spikeKill) score += WEIGHTS.spike
      if (isZeroToDeath) score += WEIGHTS.zeroToDeath
      if (isGimp) score += WEIGHTS.gimp
      if (
        isZeroToDeath ||
        isGimp ||
        spikeKill ||
        punishDamage >= 70 ||
        comboMoves >= 6 ||
        distinctMoves >= 5
      )
        flavors.push('skill')

      // 2) Drama — real comebacks + a light stakes nudge (NOT the driver).
      score += comebackMagnitude * WEIGHTS.comeback
      if (comebackMagnitude >= 0.2) flavors.push('comeback')
      score += swing * WEIGHTS.swing
      if (lastStock) score += WEIGHTS.lastStock
      if (closeGame) score += WEIGHTS.closeGame
      if (killerOnLastStock) score += WEIGHTS.killerLastStock
      if (bothLastStock) score += WEIGHTS.bothLastStock
      score +=
        (Math.min(tensionSecs, TENSION_CAP_SEC) / TENSION_CAP_SEC) *
        WEIGHTS.tension
      if (lastStock || closeGame || bothLastStock || tensionSecs >= 2)
        flavors.push('clutch')

      // 3) Chaos.
      const chaos =
        (isSD ? WEIGHTS.sd : 0) +
        (isTrade ? WEIGHTS.trade : 0) +
        (disrespect ? WEIGHTS.disrespect : 0)
      score += chaos
      if (isSD || isTrade || disrespect) flavors.push('chaos')

      score += Math.min(damageRate, 60) * WEIGHTS.intensity
      score = Math.round(score * 10) / 10

      if (score < minScore) continue

      // --- Bound the clip (cap trims the front, KO stays at the end) ---
      const stockStart = s.startFrame ?? 0
      const exchangeStart = killConv?.startFrame ?? deathFrame - DMG_WINDOW
      const endFrame = deathFrame + tail
      const startFrame = capStart(
        Math.max(0, stockStart, exchangeStart - leadIn),
        endFrame,
      )

      const metrics: HighlightMetrics = {
        score,
        flavors,
        winProbSwing: Math.round(swing * 1000) / 1000,
        comebackMagnitude: Math.round(comebackMagnitude * 1000) / 1000,
        killerWinProbAfter: Math.round(wpAfter * 1000) / 1000,
        lastStock,
        killerStocks,
        victimStocksAfter,
        comboDamage: Math.round(comboDamage),
        comboMoves,
        isZeroToDeath,
        isGimp,
        isSD,
        isTrade,
        disrespect,
        damageRate: Math.round(damageRate * 10) / 10,
        victimPercentAtDeath: Math.round(victimPct),
        isSurvival: false,
        perilPercent: 0,
        distinctMoves,
        spikeKill,
        killMove: MOVE_NAME[killMoveId] || '',
        bothLastStock,
        tensionSecs: Math.round(tensionSecs * 10) / 10,
        reason: '',
      }
      metrics.reason = buildReason(metrics)

      // killer/victim player filters (optional)
      if (
        !matchesPlayer(
          killer,
          params.comboerChar,
          params.comboerTag,
          params.comboerCC,
        )
      )
        continue
      if (
        !matchesPlayer(
          victim,
          params.comboeeChar,
          params.comboeeTag,
          params.comboeeCC,
        )
      )
        continue

      candidates.push({
        ...srcFields,
        startFrame,
        endFrame,
        comboer: killer,
        comboee: victim,
        highlightScore: score,
        highlightMetrics: metrics,
      } as ClipInterface)
    }

    // === Near-death SURVIVALS ===
    // The other half of hype: eat a lethal-percent combo and live. Anchor on a
    // conversion that reached SURVIVAL_MIN_PCT+ but did NOT kill, where the
    // survivor also doesn't die in the SURVIVAL_RESET frames after (else it was
    // just a delayed kill). Scored on peril (how close to death), the combo's
    // spectacle, an offstage-escape bonus, and stakes.
    if (includeSurvivals) {
      for (const c of conversions) {
        if (c.didKill) continue
        const survivorIdx = c.playerIndex as number
        const attacker = players.find((p) => p.playerIndex != survivorIdx)
        const survivor = players.find((p) => p.playerIndex == survivorIdx)
        if (!attacker || !survivor) continue
        const cEnd = (c.endFrame ?? c.startFrame) as number
        if (cEnd == null) continue

        const perilPct = c.currentPercent ?? c.endPercent ?? 0
        if (perilPct < SURVIVAL_MIN_PCT) continue

        // Must actually survive — no death of the survivor right after.
        const diedSoon = deaths.some(
          (d) =>
            d.playerIndex == survivorIdx &&
            (d.endFrame ?? 0) >= cEnd &&
            (d.endFrame ?? 0) <= cEnd + SURVIVAL_RESET,
        )
        if (diedSoon) continue

        if (
          !matchesPlayer(
            attacker,
            params.comboerChar,
            params.comboerTag,
            params.comboerCC,
          )
        )
          continue
        if (
          !matchesPlayer(
            survivor,
            params.comboeeChar,
            params.comboeeTag,
            params.comboeeCC,
          )
        )
          continue

        const comboDamage = Math.max(0, perilPct - (c.startPercent ?? perilPct))
        const comboMoves = c.moves?.length ?? 0
        const distinctMoves = c.moves
          ? new Set(c.moves.map((mv: any) => mv.moveId)).size
          : 0
        const pos = frames[cEnd]?.players?.[survivorIdx]?.post
        const offstageEscape =
          !!rects &&
          !!pos &&
          (Math.abs(pos.positionX) > rects.stageEnd ||
            pos.positionY < rects.edge.yMin)
        const survivorStocks = stocksRemainingAt(stocks, survivorIdx, cEnd)
        const attackerStocks = stocksRemainingAt(
          stocks,
          attacker.playerIndex,
          cEnd,
        )
        const lastStock = survivorStocks <= 1
        const closeGame = survivorStocks <= 2 && attackerStocks <= 2
        const bothLastStock = survivorStocks <= 1 && attackerStocks <= 1
        const tensionSecs = tensionSeconds(
          frames,
          survivorIdx,
          attacker.playerIndex,
          cEnd,
        )

        let score = WEIGHTS.survivalBase
        score += clamp((perilPct - SURVIVAL_MIN_PCT) / 60, 0, 1) * WEIGHTS.survivalPeril // prettier-ignore
        score += comboDamage * WEIGHTS.combo + Math.min(comboMoves, 8) * WEIGHTS.moves // prettier-ignore
        score += Math.max(0, distinctMoves - 2) * WEIGHTS.diversity
        if (offstageEscape) score += WEIGHTS.survivalEscape
        if (lastStock) score += WEIGHTS.lastStock + WEIGHTS.killerLastStock // survived on last stock = clutch // prettier-ignore
        if (closeGame) score += WEIGHTS.closeGame
        if (bothLastStock) score += WEIGHTS.bothLastStock
        score += (Math.min(tensionSecs, TENSION_CAP_SEC) / TENSION_CAP_SEC) * WEIGHTS.tension // prettier-ignore
        score = Math.round(score * 10) / 10
        if (score < minScore) continue

        const flavors = ['clutch']
        if (comboDamage >= 60 || comboMoves >= 6) flavors.push('skill')

        const endFrame = cEnd + tail
        const startFrame = capStart(
          Math.max(0, (c.startFrame ?? cEnd - DMG_WINDOW) - leadIn),
          endFrame,
        )

        const metrics: HighlightMetrics = {
          score,
          flavors,
          winProbSwing: 0,
          comebackMagnitude: 0,
          killerWinProbAfter: 0,
          lastStock,
          killerStocks: attackerStocks,
          victimStocksAfter: survivorStocks,
          comboDamage: Math.round(comboDamage),
          comboMoves,
          isZeroToDeath: false,
          isGimp: false,
          isSD: false,
          isTrade: false,
          disrespect: false,
          damageRate: 0,
          victimPercentAtDeath: Math.round(perilPct),
          isSurvival: true,
          perilPercent: Math.round(perilPct),
          distinctMoves,
          spikeKill: false,
          killMove: '',
          bothLastStock,
          tensionSecs: Math.round(tensionSecs * 10) / 10,
          reason: '',
        }
        metrics.reason = buildReason(metrics)

        candidates.push({
          ...srcFields,
          startFrame,
          endFrame,
          comboer: attacker,
          comboee: survivor,
          highlightScore: score,
          highlightMetrics: metrics,
        } as ClipInterface)
      }
    }

    // Dedup, then keep the top N per game (or everything above minScore).
    // Greedy best-first: skip a candidate that heavily overlaps a kept one — a
    // survival right before its own death, two conversions inside one punish,
    // etc. — so the reel doesn't get near-duplicate clips of one exchange.
    candidates.sort((a, b) => (b.highlightScore ?? 0) - (a.highlightScore ?? 0))
    const deduped: ClipInterface[] = []
    for (const c of candidates) {
      const cs = c.startFrame as number
      const ce = c.endFrame as number
      const clen = Math.max(1, ce - cs)
      const overlapsKept = deduped.some((k) => {
        const ks = k.startFrame as number
        const ke = k.endFrame as number
        const ov = Math.max(0, Math.min(ce, ke) - Math.max(cs, ks))
        return ov / Math.min(clen, Math.max(1, ke - ks)) > 0.4
      })
      if (!overlapsKept) deduped.push(c)
    }
    const kept = maxPerGame > 0 ? deduped.slice(0, maxPerGame) : deduped
    for (const c of kept) results.push(c)
  }

  return results
}
