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
    if (!file.players || file.players.length < 2) return false

    const { stage, char1, char2, player1, player2, player1CC, player2CC } =
      params

    if (stage) {
      const stageArray = Array.isArray(stage) ? stage : [stage]
      if (stageArray.indexOf(file.stage.toString()) === -1) return false
    }

    if (char1 || char2) {
      let c1 = char1
      let c2 = char2
      if (char1 && !Array.isArray(char1)) c1 = [char1]
      if (char2 && !Array.isArray(char2)) c2 = [char2]
      if (file.players[0]?.characterId == null) return false
      if (file.players[1]?.characterId == null) return false
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
    const hasP1 = Array.isArray(player1) ? player1.length > 0 : !!player1
    const hasP2 = Array.isArray(player2) ? player2.length > 0 : !!player2
    const hasP1CC = Array.isArray(player1CC)
      ? player1CC.length > 0
      : !!player1CC
    const hasP2CC = Array.isArray(player2CC)
      ? player2CC.length > 0
      : !!player2CC
    if (hasP1 || hasP2 || hasP1CC || hasP2CC) {
      const p1Tags = Array.isArray(player1)
        ? player1.map((t: string) => t.toLowerCase())
        : player1
          ? player1.toLowerCase().split(';')
          : []
      const p2Tags = Array.isArray(player2)
        ? player2.map((t: string) => t.toLowerCase())
        : player2
          ? player2.toLowerCase().split(';')
          : []
      const p1CCs = Array.isArray(player1CC)
        ? player1CC.map((t: string) => t.toLowerCase())
        : player1CC
          ? player1CC.toLowerCase().split(';')
          : []
      const p2CCs = Array.isArray(player2CC)
        ? player2CC.map((t: string) => t.toLowerCase())
        : player2CC
          ? player2CC.toLowerCase().split(';')
          : []
      const lp1Name = (file.players[0]?.displayName || '').toLowerCase()
      const lp2Name = (file.players[1]?.displayName || '').toLowerCase()
      const lp1CC = (file.players[0]?.connectCode || '').toLowerCase()
      const lp2CC = (file.players[1]?.connectCode || '').toLowerCase()

      // A player slot matches constraint set 1 if name matches OR connect code matches
      const slot1MatchesC1 =
        (!hasP1 || p1Tags.indexOf(lp1Name) !== -1) &&
        (!hasP1CC || p1CCs.indexOf(lp1CC) !== -1)
      const slot2MatchesC1 =
        (!hasP1 || p1Tags.indexOf(lp2Name) !== -1) &&
        (!hasP1CC || p1CCs.indexOf(lp2CC) !== -1)
      const slot1MatchesC2 =
        (!hasP2 || p2Tags.indexOf(lp1Name) !== -1) &&
        (!hasP2CC || p2CCs.indexOf(lp1CC) !== -1)
      const slot2MatchesC2 =
        (!hasP2 || p2Tags.indexOf(lp2Name) !== -1) &&
        (!hasP2CC || p2CCs.indexOf(lp2CC) !== -1)

      const hasC1 = hasP1 || hasP1CC
      const hasC2 = hasP2 || hasP2CC
      if (hasC1 && hasC2) {
        if (
          !(
            (slot1MatchesC1 && slot2MatchesC2) ||
            (slot2MatchesC1 && slot1MatchesC2)
          )
        )
          return false
      } else if (hasC1 && !hasC2) {
        if (!(slot1MatchesC1 || slot2MatchesC1)) return false
      } else if (hasC2 && !hasC1) {
        if (!(slot1MatchesC2 || slot2MatchesC2)) return false
      }
    }
    return true
  })
}
