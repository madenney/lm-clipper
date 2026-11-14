import { ClipInterface, TrimParams } from '../../constants/types'
import { GAME_START_FRAME } from '../../constants/frames'

export default (prevResults: ClipInterface[], params: TrimParams) => {
  const addStart = parseInt(params.addStartFrames ?? '', 10) || 0
  const addEnd = parseInt(params.addEndFrames ?? '', 10) || 0

  if (addStart === 0 && addEnd === 0) return prevResults

  return prevResults.map((clip) => {
    const startFrame =
      typeof clip.startFrame === 'number'
        ? clip.startFrame
        : parseInt(clip.startFrame, 10)
    const endFrame =
      typeof clip.endFrame === 'number'
        ? clip.endFrame
        : parseInt(clip.endFrame, 10)

    if (Number.isNaN(startFrame) || Number.isNaN(endFrame)) return clip

    // endFrame 0 is a combo still going when the game ended: "to the end of the
    // game". Its end is left alone, not turned into frame 0 + addEnd (a 1-frame
    // clip, launch review FLT-4).
    const openEnded = !(endFrame > 0)

    // Extend start earlier (lower frame) or trim start later (higher frame)
    let newStart = startFrame - addStart
    // Extend end later (higher frame) or trim end earlier (lower frame)
    let newEnd = openEnded ? 0 : endFrame + addEnd

    // Clamp: start can't go below Melee's universal start frame
    if (newStart < GAME_START_FRAME) newStart = GAME_START_FRAME

    // Clamp: end must be at least 1 frame after start
    if (!openEnded && newEnd <= newStart) newEnd = newStart + 1

    return {
      ...clip,
      startFrame: newStart,
      endFrame: newEnd,
    }
  })
}
