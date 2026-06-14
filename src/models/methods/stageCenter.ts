/* eslint-disable eqeqeq */
import { SlippiGame } from '@slippi/slippi-js'
import {
  ClipInterface,
  EventEmitterInterface,
  StageCenterParams,
} from '../../constants/types'

/**
 * Keep combos that started within a given horizontal distance of the stage's
 * center vertical line. Melee world coordinates put stage center at x = 0, so
 * the distance from the middle line is |positionX|.
 *
 * Position is sampled at the combo's first move frame. By default the comboee
 * (the player being combo'd) is measured; enable `useComboer` to measure the
 * attacker instead. Requires frame data, so run after a Combo Parser.
 */
export default (
  prevResults: ClipInterface[],
  params: StageCenterParams,
  eventEmitter: EventEmitterInterface,
) => {
  const max = parseInt(params.maxDistance, 10)
  if (Number.isNaN(max)) return prevResults

  return prevResults.filter((clip, index) => {
    eventEmitter({ current: index, total: prevResults.length })
    const { combo, comboer, comboee, path } = clip
    if (!combo?.moves?.length) return false
    const target = params.useComboer ? comboer : comboee
    if (!target) return false

    let frames: Record<string, any>
    try {
      frames = new SlippiGame(path).getFrames()
    } catch (e) {
      return false
    }

    const startFrame = combo.moves[0].frame
    const frame = frames[startFrame]
    if (!frame?.players) return false
    const player = frame.players.find(
      (p: any) => p?.post?.playerIndex == target.playerIndex,
    )
    if (!player?.post) return false

    return Math.abs(player.post.positionX) <= max
  })
}
