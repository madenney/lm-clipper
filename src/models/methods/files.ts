import {
  FileInterface,
  EventEmitterInterface,
  FilesFilterParams,
} from '../../constants/types'
import { isCpuGame } from '../../lib/cpuPlayers'
import { parseSemicolonParam } from '../../lib/filterHelpers'

export default (
  prevResults: FileInterface[],
  params: FilesFilterParams,
  eventEmitter: EventEmitterInterface,
) => {
  return prevResults.filter((file: FileInterface, index) => {
    if (index % 100 === 0)
      eventEmitter({ current: index, total: prevResults.length })
    if (!file.isValid) return false
    if (!file.players || file.players.length < 2) return false
    // Games with a CPU player are left out unless asked for. Not checked yet
    // (older imports, until the background check reaches them) counts as human.
    if (params.includeCpu !== true && isCpuGame(file.players)) return false

    const { stage, char1, char2, player1, player2, player1CC, player2CC } =
      params

    const hasStage = Array.isArray(stage) ? stage.length > 0 : !!stage
    if (hasStage) {
      const stageArray = (Array.isArray(stage) ? stage : [stage]).map(String)
      if (stageArray.indexOf(file.stage.toString()) === -1) return false
    }

    const hasChar1 = Array.isArray(char1) ? char1.length > 0 : !!char1
    const hasChar2 = Array.isArray(char2) ? char2.length > 0 : !!char2
    if (hasChar1 || hasChar2) {
      const c1 = hasChar1
        ? (Array.isArray(char1) ? char1 : [char1]).map(String)
        : null
      const c2 = hasChar2
        ? (Array.isArray(char2) ? char2 : [char2]).map(String)
        : null
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
    const p1Tags = parseSemicolonParam(player1)
    const p2Tags = parseSemicolonParam(player2)
    const p1CCs = parseSemicolonParam(player1CC)
    const p2CCs = parseSemicolonParam(player2CC)
    const hasP1 = p1Tags.length > 0
    const hasP2 = p2Tags.length > 0
    const hasP1CC = p1CCs.length > 0
    const hasP2CC = p2CCs.length > 0
    if (hasP1 || hasP2 || hasP1CC || hasP2CC) {
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
