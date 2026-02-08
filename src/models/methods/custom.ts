import { ClipInterface, EventEmitterInterface } from 'constants/types'

export default (
  prevResults: ClipInterface[],
  params: { [key: string]: any },
  eventEmitter: EventEmitterInterface,
) => {
  const results: ClipInterface[] = []

  const { maxFiles, n } = params

  const limit =
    maxFiles === '' || maxFiles === undefined
      ? undefined
      : parseInt(maxFiles, 10)

  const total =
    limit === undefined
      ? prevResults.length
      : Math.min(limit, prevResults.length)

  prevResults.slice(0, limit).forEach((prevResult, index) => {
    eventEmitter({ current: index, total })

    const { combo } = prevResult
    if (!combo || !combo.moves) return false
    const { moves } = combo
    switch (n) {
      case 'test':
        console.log('MOVES: ', moves)
        let upBCount = 0
        moves.forEach((move) => {
          if (move.moveId === 20) {
            upBCount++
          }
        })
        if (upBCount > 3) {
          results.push(prevResult)
        }
        break
      default:
        return false
    }
  })

  return results
}
