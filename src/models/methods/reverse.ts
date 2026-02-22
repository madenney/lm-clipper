/* eslint-disable eqeqeq */
import { SlippiGame } from '@slippi/slippi-js'

const isReverseHit = (frames: any, move: any, comboer: any, comboee: any) => {
  const currentFrame = frames[move.frame]
  if (!currentFrame?.players) return false
  const _comboer = currentFrame.players.find(
    (p: any) => p?.post?.playerIndex == comboer.playerIndex,
  )
  const _comboee = currentFrame.players.find(
    (p: any) => p?.post?.playerIndex == comboee.playerIndex,
  )
  if (!_comboer?.post || !_comboee?.post) return false

  const comboerX = _comboer.post.positionX
  const comboerFacing = _comboer.post.facingDirection
  const comboeeX = _comboee.post.positionX
  const isBair = move.moveId === 15

  if (!isBair) {
    // Normal move: reverse hit = facing away from opponent
    if (comboerX > comboeeX) {
      return comboerFacing == 1
    }
    return comboerFacing == -1
  }
  // Bair: reverse hit = facing toward opponent (bair naturally hits behind)
  if (comboerX > comboeeX) {
    return comboerFacing == -1
  }
  return comboerFacing == 1
}

export default (prevResults: any[], params: any, eventEmitter: any) => {
  const { maxFiles, n } = params
  const limit =
    maxFiles === '' || maxFiles == null ? undefined : parseInt(maxFiles, 10)
  const total = limit ? Math.min(limit, prevResults.length) : prevResults.length

  return prevResults.slice(0, limit).filter((clip, index) => {
    eventEmitter({ current: index, total })

    const { comboer, comboee, path, combo } = clip
    if (!comboer || !comboee || !combo?.moves || combo.moves.length === 0)
      return false
    const { moves } = combo

    const game = new SlippiGame(path)
    let frames: any
    try {
      frames = game.getFrames()
    } catch (e) {
      console.log('Broken file:', path)
      return false
    }

    // Parse position dropdown value
    const nStr = n ? String(n) : ''
    const cleaned = nStr
      .split(',')
      .map((s: string) => s.trim())
      .filter((s: string) => s !== '__custom__' && s !== '')

    // Collect target moves to check
    const targetMoves: any[] = []

    if (cleaned.length === 0) {
      // No position specified: check all moves
      targetMoves.push(...moves)
    } else if (cleaned.includes('e')) {
      // 'e' = every move must be a reverse hit
      return moves.every((move: any) =>
        isReverseHit(frames, move, comboer, comboee),
      )
    } else {
      // Specific indices
      const indices = cleaned
        .map((s: string) => parseInt(s, 10))
        .filter((v: number) => !Number.isNaN(v))

      for (const idx of indices) {
        const mi = idx >= 0 ? idx : moves.length + idx
        if (moves[mi]) targetMoves.push(moves[mi])
      }
    }

    if (targetMoves.length === 0) return false

    // Any target move being a reverse hit qualifies
    return targetMoves.some((move: any) =>
      isReverseHit(frames, move, comboer, comboee),
    )
  })
}
