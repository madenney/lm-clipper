/* eslint-disable eqeqeq */
import { SlippiGame } from '../../lib/slippiGame'
import { ClipInterface, KoDirectionParams } from '../../constants/types'
import { getDeathDirection } from '../../vendor/replay-analysis'
import { computeStocks } from '../../lib/slippiStocks'

export default (prevResults: ClipInterface[], params: KoDirectionParams) => {
  const { direction } = params
  const directions: string[] = Array.isArray(direction) ? direction : []
  if (directions.length === 0) return prevResults

  // Clips of one game come together: its stocks are worked out once, with the
  // stock computer alone (not getStats(), which runs every stat computer).
  let cachedPath: string | null = null
  let cachedStocks: ReturnType<typeof computeStocks> | undefined

  return prevResults.filter((clip) => {
    const { path, comboee, endFrame } = clip
    if (!comboee || !clip.combo?.didKill) return false

    let stocks: ReturnType<typeof computeStocks> | undefined
    try {
      if (cachedPath !== path) {
        // The constructor opens the file: a missing or corrupt replay skips
        // this clip instead of failing the whole run (launch review FLT-10).
        cachedStocks = computeStocks(new SlippiGame(path))
        cachedPath = path
      }
      stocks = cachedStocks
    } catch (e) {
      cachedPath = null
      return false
    }
    if (!stocks) return false

    const _endFrame =
      typeof endFrame === 'number' ? endFrame : parseInt(endFrame, 10)
    if (Number.isNaN(_endFrame)) return false

    // Find the stock loss that matches this combo's kill
    const stock = stocks.find(
      (s) =>
        s.playerIndex == comboee.playerIndex &&
        s.endFrame != null &&
        Math.abs(s.endFrame - _endFrame) <= 60,
    )

    if (!stock || stock.deathAnimation == null) return false

    const dir = getDeathDirection(stock.deathAnimation)
    return dir !== null && directions.includes(dir)
  })
}
