import { SlippiGame } from '@slippi/slippi-js'
import {
  ClipInterface,
  EventEmitterInterface,
  AfkDetectionParams,
} from '../../constants/types'
import { GAME_START_FRAME } from '../../constants/frames'

const JOYSTICK_DEADZONE = 0.3
const FPS = 60

export default (
  prevResults: ClipInterface[],
  params: AfkDetectionParams,
  eventEmitter: EventEmitterInterface,
) => {
  const maxInputsPerSec = parseFloat(params.maxInputsPerSec ?? '') || 2
  const exclude = params.exclude !== false

  return prevResults.filter((clip, index) => {
    eventEmitter({ current: index, total: prevResults.length })

    const { path, comboee, startFrame, endFrame } = clip
    const game = new SlippiGame(path)
    let frames
    try {
      frames = game.getFrames()
    } catch {
      return true
    }

    // Determine which player index to check for AFK
    // If we have parsed data, check the comboee (opponent receiving the combo)
    // Otherwise check all players and flag if any are AFK
    const playerIndices: number[] = comboee
      ? [comboee.playerIndex]
      : (clip.players || []).map((p) => p.playerIndex)

    const start = Math.max(startFrame, GAME_START_FRAME)
    const end = endFrame

    for (const pi of playerIndices) {
      let activeFrames = 0
      let totalFrames = 0

      for (let f = start; f <= end; f++) {
        const frame = frames[f]
        if (!frame) continue
        const player = Object.values(frame.players ?? {}).find(
          (p) => p?.pre?.playerIndex === pi,
        )
        if (!player?.pre) continue

        totalFrames++
        const pre = player.pre

        const hasJoystick =
          Math.abs(pre.joystickX ?? 0) > JOYSTICK_DEADZONE ||
          Math.abs(pre.joystickY ?? 0) > JOYSTICK_DEADZONE
        const hasCStick =
          Math.abs(pre.cStickX ?? 0) > JOYSTICK_DEADZONE ||
          Math.abs(pre.cStickY ?? 0) > JOYSTICK_DEADZONE
        const hasTrigger =
          (pre.physicalLTrigger ?? 0) > 0.3 || (pre.physicalRTrigger ?? 0) > 0.3
        const hasButtons = (pre.physicalButtons ?? 0) !== 0

        if (hasJoystick || hasCStick || hasTrigger || hasButtons) {
          activeFrames++
        }
      }

      if (totalFrames === 0) continue

      const durationSec = totalFrames / FPS
      const inputsPerSec = activeFrames / durationSec
      const isAfk = inputsPerSec <= maxInputsPerSec

      if (isAfk) {
        return !exclude
      }
    }

    return exclude
  })
}
