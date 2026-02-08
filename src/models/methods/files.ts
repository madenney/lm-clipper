import { FileInterface, EventEmitterInterface } from '../../constants/types'

export default (
  prevResults: FileInterface[],
  params: { [key: string]: any },
  eventEmitter: EventEmitterInterface,
) => {
  console.log(prevResults)
  return prevResults.filter((file: FileInterface, index) => {
    if (index % 100 === 0)
      eventEmitter({ current: index, total: prevResults.length })
    if (!file.isValid) return false

    const { stage, char1, char2, player1, player2 } = params

    if (stage) {
      const stageArray = Array.isArray(stage) ? stage : [stage]
      if (stageArray.indexOf(file.stage.toString()) === -1) return false
    }

    if (char1 || char2) {
      let c1 = char1
      let c2 = char2
      if (char1 && !Array.isArray(char1)) c1 = [char1]
      if (char2 && !Array.isArray(char2)) c2 = [char2]
      if (file.players[0].characterId == null) return false
      if (file.players[1].characterId == null) return false
      const p1 = file.players[0].characterId.toString()
      const p2 = file.players[1].characterId.toString()
      if (c1 && c2) {
        if (
          !(
            (c1.indexOf(p1) !== -1 && c2.indexOf(p2) !== -1) ||
            (c1.indexOf(p2) !== -1 && c2.indexOf(p1) !== -1)
          )
        )
          return false
      } else if (c1 && !c2) {
        if (!(c1.indexOf(p1) !== -1 || c1.indexOf(p2) !== -1)) return false
      } else if (c2 && !c1) {
        if (!(c2.indexOf(p1) !== -1 || c2.indexOf(p2) !== -1)) return false
      }
    }
    if (player1 || player2) {
      const p1 = player1.toLowerCase().split(';')
      const p2 = player2.toLowerCase().split(';')
      const lp1 = file.players[0].displayName.toLowerCase()
      const lp2 = file.players[1].displayName.toLowerCase()
      if (player1 && player2) {
        if (
          !(
            (p1.indexOf(lp1) !== -1 && p2.indexOf(lp2) !== -1) ||
            (p1.indexOf(lp2) !== -1 && p2.indexOf(lp1) !== -1)
          )
        )
          return false
      } else if (player1 && !player2) {
        if (!(p1.indexOf(lp1) !== -1 || p1.indexOf(lp2) !== -1)) return false
      } else if (player2 && !player1) {
        if (!(p2.indexOf(lp1) !== -1 || p2.indexOf(lp2) !== -1)) return false
      }
    }
    return true
  })
}
