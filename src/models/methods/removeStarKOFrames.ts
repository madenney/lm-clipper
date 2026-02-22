/* eslint-disable eqeqeq */
/* eslint-disable no-plusplus */
/* eslint-disable no-underscore-dangle */
import { SlippiGame } from '@slippi/slippi-js'

const starKOIDs = [3, 4, 5, 6, 7, 8, 9, 10]

export default (prevResults, params, eventEmitter) => {
  return prevResults.map((clip, index) => {
    const { path, comboee, startFrame, endFrame } = clip
    const { maxFiles } = params
    eventEmitter({
      current: index,
      total: maxFiles === '' ? prevResults.length : parseInt(maxFiles, 10),
    })

    if (!comboee) return clip

    const game = new SlippiGame(path)
    let frames
    try {
      frames = game.getFrames()
    } catch (e) {
      console.log('Broken file:', path)
      return clip
    }

    const _endFrame = parseInt(endFrame, 10)
    const _startFrame = parseInt(startFrame, 10)
    if (Number.isNaN(_endFrame) || Number.isNaN(_startFrame)) return clip

    // Lets just assume star KO frames happen at the end of the clip
    // find them and work backwards
    let newEndFrame
    for (let i = _endFrame; i > _startFrame; i--) {
      const currentFrame = frames[i]
      if (!currentFrame?.players) break
      const _comboee = currentFrame.players.find(
        (p) => p?.post?.playerIndex == comboee.playerIndex,
      )
      if (!_comboee?.post) break
      if (starKOIDs.indexOf(_comboee.post.actionStateId) > -1) {
        newEndFrame = i - 1
      } else {
        break
      }
    }

    return {
      ...clip,
      endFrame: newEndFrame ? newEndFrame + 5 : endFrame,
    }
  })
}
