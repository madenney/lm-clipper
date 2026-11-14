/* eslint-disable eqeqeq */
/*
 * Edgeguards parser. The detection (knocked offstage by a hit, denied, dies
 * without recovering) is detectEdgeguard / findEdgeguards in the shared
 * replay-analysis package, which documents the rules in full. This file applies
 * Clipper's parameters and player filters and shapes the clips.
 */
import { createHash } from 'crypto'
import { StockType } from '@slippi/slippi-js'
import { readReplayBytes } from '../../lib/slpz'
import { SlippiGame } from '../../lib/slippiGame'
import {
  edgeguardRects,
  DEFAULT_OFFSTAGE_BUFFER,
} from '../../constants/stageGeometry'
import { computeStocks } from '../../lib/slippiStocks'
import matchesAny from './matchesAny'
import { matchesPlayer } from '../../lib/filterHelpers'
import {
  FileInterface,
  ClipInterface,
  EdgeguardParams,
  EventEmitterInterface,
  PlayerInterface,
} from '../../constants/types'
import {
  currentStockStart,
  detectEdgeguard,
  DetectOpts,
  findEdgeguards,
} from '../../vendor/replay-analysis'
import { DetectionCache, EDGEGUARD_DETECTOR } from '../detectionCache'

type Edgeguards = ReturnType<typeof findEdgeguards>

/** The last frame number of a game (a loop: spreading 200k keys overflows the stack). */
function lastFrameOf(frames: object): number {
  let max = 0
  for (const key of Object.keys(frames)) {
    const n = Number(key)
    if (n > max) max = n
  }
  return max
}

export default (
  prevResults: (FileInterface | ClipInterface)[],
  params: EdgeguardParams,
  _eventEmitter: EventEmitterInterface,
  cache?: DetectionCache | null,
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

  // Everything that changes what findEdgeguards finds for a game; the player
  // and stage filters apply to its output. Files mode is cached per game.
  const cacheKey = {
    ...EDGEGUARD_DETECTOR,
    paramsKey: JSON.stringify({ ...opts, offstageBuffer }),
  }

  // Combo mode: the edgeguard already made for a victim's stock.
  const byStock = new Map<string, { index: number; clipEnd: number }>()

  for (const item of prevResults) {
    const { path, players, stage } = item

    if (!matchesAny(stage, stageFilter)) continue

    const stageRects = edgeguardRects(stage, offstageBuffer)
    if (!stageRects) continue

    // Files mode with a cache: edgeguards found in an earlier run are reused
    // without opening the replay.
    let events: Edgeguards | null = null
    if (cache && !('combo' in item && item.combo) && players) {
      const cached = cache.get<Edgeguards>(path, cacheKey)
      if (cached.data) events = cached.data
      else if (cached.seen) {
        try {
          const bytes = readReplayBytes(path)
          const g = new SlippiGame(bytes)
          const st = computeStocks(g)
          events = st.length
            ? findEdgeguards(
                g.getFrames(),
                st,
                players,
                stage,
                opts,
                offstageBuffer,
              )
            : []
          cache.put(
            cached.seen,
            createHash('md5').update(bytes).digest('hex'),
            cacheKey,
            events,
          )
        } catch (e) {
          continue
        }
      }
    }

    let game: SlippiGame
    let stocks: StockType[] = []
    let frames: ReturnType<SlippiGame['getFrames']> = {}
    if (!events)
      try {
        game = new SlippiGame(path)
        // Stocks-only: skip the 5 stat computers + overall stats getStats() would
        // otherwise run on every frame (we only need death frames here).
        stocks = computeStocks(game)
        frames = game.getFrames()
      } catch (e) {
        continue
      }
    if (!events && !stocks.length) continue

    if ('combo' in item && item.combo) {
      const { comboer, comboee } = item
      if (!comboer || !comboee) continue
      if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC)) continue
      if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC)) continue

      // The combo's victim must die at/after the combo's end, and soon after it
      // (within the detector's look-back): a victim who survives the combo and
      // loses a stock minutes later was not edgeguarded as a result of it. A
      // combo still open when the game ended (endFrame 0) ends at the game's
      // last frame.
      const clipEnd =
        Number(item.endFrame) > 0 ? Number(item.endFrame) : lastFrameOf(frames)
      const matchingStock = stocks
        .filter(
          (s) =>
            s.playerIndex == comboee.playerIndex &&
            s.endFrame != null &&
            s.endFrame >= clipEnd &&
            s.endFrame - clipEnd <= opts.maxLookbackFrames,
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
        const clip = {
          ...item,
          startFrame: eg.startFrame,
          endFrame: eg.endFrame,
          edgeguardScore: eg.metrics.score,
          edgeguardMetrics: eg.metrics,
        }
        // One clip per stock: several combos before the same death would all
        // produce this same edgeguard. The latest combo (closest to the death)
        // is the one the clip is labelled with.
        const stockKey = `${path}|${comboee.playerIndex}|${matchingStock.startFrame}`
        const at = byStock.get(stockKey)
        if (at === undefined) {
          byStock.set(stockKey, { index: results.length, clipEnd })
          results.push(clip)
        } else if (clipEnd > at.clipEnd) {
          results[at.index] = clip
          at.clipEnd = clipEnd
        }
      }
    } else {
      // Files mode: scan every stock; the victim is whoever lost the stock.
      if (!players) continue
      events ??= findEdgeguards(
        frames,
        stocks,
        players,
        stage,
        opts,
        offstageBuffer,
      )
      for (const eg of events) {
        const comboer = players.find(
          (p: PlayerInterface) => p.playerIndex == eg.edgeguarderIndex,
        )
        const comboee = players.find(
          (p: PlayerInterface) => p.playerIndex == eg.victimIndex,
        )
        if (!comboer || !comboee) continue
        if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC))
          continue
        if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC))
          continue
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

  return results
}
