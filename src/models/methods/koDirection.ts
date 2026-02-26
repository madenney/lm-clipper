/* eslint-disable eqeqeq */
import { SlippiGame } from '@slippi/slippi-js'

function getDeathDirection(actionStateId: number): string | null {
  if (actionStateId > 10) return null
  switch (actionStateId) {
    case 0:
      return 'down'
    case 1:
      return 'left'
    case 2:
      return 'right'
    default:
      return 'up'
  }
}

export default (prevResults: any[], params: any) => {
  const { direction } = params
  const directions: string[] = Array.isArray(direction) ? direction : []
  if (directions.length === 0) return prevResults

  return prevResults.filter((clip: any) => {
    const { path, comboee, endFrame } = clip
    if (!comboee || !clip.combo?.didKill) return false

    const game = new SlippiGame(path)
    let stocks: any[] | undefined
    try {
      stocks = game.getStats()?.stocks
    } catch (e) {
      return false
    }
    if (!stocks) return false

    const _endFrame =
      typeof endFrame === 'number' ? endFrame : parseInt(endFrame, 10)
    if (Number.isNaN(_endFrame)) return false

    // Find the stock loss that matches this combo's kill
    const stock = stocks.find(
      (s: any) =>
        s.playerIndex == comboee.playerIndex &&
        s.endFrame != null &&
        Math.abs(s.endFrame - _endFrame) <= 60,
    )

    if (!stock || stock.deathAnimation == null) return false

    const dir = getDeathDirection(stock.deathAnimation)
    return dir !== null && directions.includes(dir)
  })
}
