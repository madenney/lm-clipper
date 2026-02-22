/* eslint-disable eqeqeq */
import { SlippiGame } from '@slippi/slippi-js'
import rectangles from '../../constants/rectangles'

const damageStates = [
  0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57,
  0x58, 0x59, 0x5a, 0x5b,
]

type Rect = { xMin: number; xMax: number; yMin: number; yMax: number }

function areCoordsInRectangle(x: number, y: number, rect: Rect): boolean {
  return x > rect.xMin && x < rect.xMax && y > rect.yMin && y < rect.yMax
}

// Mirrored version for left side (negative X)
function areCoordsInMirroredRectangle(
  x: number,
  y: number,
  rect: Rect,
): boolean {
  return x < rect.xMin && x > rect.xMax && y > rect.yMin && y < rect.yMax
}

function detectEdgeguard(
  stock: any,
  playerIndex: number,
  frames: any,
  stageRects: any,
): { startFrame: number; endFrame: number } | null {
  if (stock.endFrame == null) return null

  const rightBlastZone = stageRects.bz
  const leftBlastZone = {
    ...rightBlastZone,
    xMin: rightBlastZone.xMin * -1,
    xMax: rightBlastZone.xMax * -1,
  }
  const rightEdge = stageRects.edge
  const leftEdge = {
    ...rightEdge,
    xMin: rightEdge.xMin * -1,
    xMax: rightEdge.xMax * -1,
  }

  // Determine which side they died on
  const penultimateFrame = frames[stock.endFrame - 1]
  if (!penultimateFrame?.players) return null
  const player = penultimateFrame.players[playerIndex]
  if (!player?.post) return null

  const x = player.post.positionX
  const y = player.post.positionY

  let side: 'left' | 'right' | null = null
  if (areCoordsInRectangle(x, y, rightBlastZone)) {
    side = 'right'
  } else if (areCoordsInMirroredRectangle(x, y, leftBlastZone)) {
    side = 'left'
  }
  if (!side) return null

  const edge = side === 'right' ? rightEdge : leftEdge

  // Check if player crossed from on-stage into edge region
  let crossedEdge = false
  if (side === 'right') {
    let cf = stock.endFrame - 1
    while (cf > 0) {
      if (frames[cf]?.players?.[playerIndex]?.post?.positionX < rightEdge.xMax)
        break
      cf--
    }
    cf -= 2
    while (cf > 0) {
      const posX = frames[cf]?.players?.[playerIndex]?.post?.positionX
      if (posX == null) break
      if (posX > rightEdge.xMax) {
        crossedEdge = true
        break
      }
      if (posX < rightEdge.xMin) break
      cf--
    }
  } else {
    let cf = stock.endFrame - 1
    while (cf > 0) {
      if (frames[cf]?.players?.[playerIndex]?.post?.positionX > leftEdge.xMax)
        break
      cf--
    }
    cf -= 2
    while (cf > 0) {
      const posX = frames[cf]?.players?.[playerIndex]?.post?.positionX
      if (posX == null) break
      if (posX < leftEdge.xMax) {
        crossedEdge = true
        break
      }
      if (posX > leftEdge.xMin) break
      cf--
    }
  }

  if (!crossedEdge) return null

  // Find last hit in damage state inside the edge region
  let cf = stock.endFrame - 1
  while (cf > 0) {
    const p = frames[cf]?.players?.[playerIndex]
    if (!p?.post) {
      cf--
      continue
    }
    const inEdge =
      side === 'right'
        ? p.post.positionX < edge.xMin
        : p.post.positionX > edge.xMin
    if (inEdge && damageStates.includes(p.post.actionStateId)) {
      return { startFrame: cf, endFrame: stock.endFrame }
    }
    cf--
  }

  return null
}

const matchesAny = (value: any, param: any) => {
  if (!param || (Array.isArray(param) && param.length === 0)) return true
  const arr = Array.isArray(param) ? param : [param]
  return arr.some((v: any) => String(v) === String(value))
}

export default (prevResults: any[], params: any, _eventEmitter: any) => {
  const results: any[] = []
  const {
    comboerChar,
    comboeeChar,
    comboerTag,
    comboeeTag,
    comboerCC,
    comboeeCC,
    stageFilter,
  } = params

  for (const item of prevResults) {
    const { path, players, stage } = item

    // Stage filter
    if (!matchesAny(stage, stageFilter)) continue

    const stageRects = rectangles[stage]
    if (!stageRects) continue

    let game: SlippiGame
    let stats: any
    let frames: any
    try {
      game = new SlippiGame(path)
      stats = game.getStats()
      frames = game.getFrames()
    } catch (e) {
      console.log('Error -', path)
      continue
    }

    // Clips mode: input has combo data from parser
    const isClipMode = !!item.combo

    if (isClipMode) {
      const { comboer, comboee } = item
      if (!comboer || !comboee) continue

      // Character filters
      if (!matchesAny(comboer.characterId, comboerChar)) continue
      if (!matchesAny(comboee.characterId, comboeeChar)) continue
      if (
        !matchesAny(
          (comboer.displayName || '').toLowerCase(),
          comboerTag &&
            (Array.isArray(comboerTag) ? comboerTag : [comboerTag]).map(
              (t: string) => t.toLowerCase(),
            ),
        )
      )
        continue
      if (
        !matchesAny(
          (comboee.displayName || '').toLowerCase(),
          comboeeTag &&
            (Array.isArray(comboeeTag) ? comboeeTag : [comboeeTag]).map(
              (t: string) => t.toLowerCase(),
            ),
        )
      )
        continue
      if (
        !matchesAny(
          (comboer.connectCode || '').toLowerCase(),
          comboerCC &&
            (Array.isArray(comboerCC) ? comboerCC : [comboerCC]).map(
              (t: string) => t.toLowerCase(),
            ),
        )
      )
        continue
      if (
        !matchesAny(
          (comboee.connectCode || '').toLowerCase(),
          comboeeCC &&
            (Array.isArray(comboeeCC) ? comboeeCC : [comboeeCC]).map(
              (t: string) => t.toLowerCase(),
            ),
        )
      )
        continue

      // Find the matching stock for this combo's kill
      const clipEnd = parseInt(item.endFrame, 10)
      const matchingStock = stats.stocks
        .filter(
          (s: any) =>
            s.playerIndex == comboee.playerIndex &&
            s.endFrame != null &&
            s.endFrame >= clipEnd,
        )
        .sort((a: any, b: any) => a.endFrame - b.endFrame)[0]

      if (!matchingStock) continue

      const eg = detectEdgeguard(
        matchingStock,
        comboee.playerIndex,
        frames,
        stageRects,
      )
      if (eg) {
        results.push({
          ...item,
          startFrame: eg.startFrame,
          endFrame: eg.endFrame,
        })
      }
    } else {
      // Files mode: scan all stocks
      if (!stats?.stocks?.length) continue

      for (const stock of stats.stocks) {
        if (stock.endFrame == null) continue
        const comboer = players.find(
          (p: any) => p.playerIndex != stock.playerIndex,
        )
        const comboee = players.find(
          (p: any) => p.playerIndex == stock.playerIndex,
        )
        if (!comboer || !comboee) continue

        // Character filters
        if (!matchesAny(comboer.characterId, comboerChar)) continue
        if (!matchesAny(comboee.characterId, comboeeChar)) continue
        if (
          !matchesAny(
            (comboer.displayName || '').toLowerCase(),
            comboerTag &&
              (Array.isArray(comboerTag) ? comboerTag : [comboerTag]).map(
                (t: string) => t.toLowerCase(),
              ),
          )
        )
          continue
        if (
          !matchesAny(
            (comboee.displayName || '').toLowerCase(),
            comboeeTag &&
              (Array.isArray(comboeeTag) ? comboeeTag : [comboeeTag]).map(
                (t: string) => t.toLowerCase(),
              ),
          )
        )
          continue
        if (
          !matchesAny(
            (comboer.connectCode || '').toLowerCase(),
            comboerCC &&
              (Array.isArray(comboerCC) ? comboerCC : [comboerCC]).map(
                (t: string) => t.toLowerCase(),
              ),
          )
        )
          continue
        if (
          !matchesAny(
            (comboee.connectCode || '').toLowerCase(),
            comboeeCC &&
              (Array.isArray(comboeeCC) ? comboeeCC : [comboeeCC]).map(
                (t: string) => t.toLowerCase(),
              ),
          )
        )
          continue

        const eg = detectEdgeguard(
          stock,
          comboee.playerIndex,
          frames,
          stageRects,
        )
        if (eg) {
          results.push({
            ...item,
            startFrame: eg.startFrame,
            endFrame: eg.endFrame,
            comboer,
            comboee,
          })
        }
      }
    }
  }

  return results
}
