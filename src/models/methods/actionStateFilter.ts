/* eslint-disable eqeqeq */
/* eslint-disable no-plusplus */
/* eslint-disable no-underscore-dangle */
import { SlippiGame } from '@slippi/slippi-js'
import { actionStates } from '../../constants/actionStates'

export default (prevResults, params, eventEmitter) => {
  const { maxFiles } = params
  return prevResults
    .slice(0, maxFiles == '' ? undefined : parseInt(maxFiles, 10))
    .filter((result, index) => {
      eventEmitter({
        current: index,
        total: maxFiles === '' ? prevResults.length : parseInt(maxFiles, 10),
      })

      const { path, comboer, comboee, startFrame, endFrame, combo } = result
      const { moves } = combo
      const {
        startFrom,
        searchRange,
        comboerActionState,
        comboeeActionState,
        startFromNthMove,
        exclude,
      } = params
      const game = new SlippiGame(path)
      let frames
      let lastFrame
      try {
        frames = game.getFrames()
        lastFrame = game.getMetadata().lastFrame
      } catch (e) {
        return console.log('Broken file:', path)
      }
      const _startFrom = parseInt(startFrom, 10)
      const _startFromNthMove = parseInt(startFromNthMove, 10)
      const _searchRange = parseInt(searchRange, 10)
      let _startFrame

      if (_startFrom) {
        _startFrame =
          _startFrom > -1
            ? frames[startFrame + _startFrom].frame
            : frames[endFrame + _startFrom].frame
      }
      if (_startFromNthMove) {
        if (!moves)
          throw Error(
            'moves is not defined. This is likely not a parsed combo clip',
          )
        _startFrame =
          _startFromNthMove > -1
            ? moves[_startFromNthMove].frame
            : moves[moves.length + _startFromNthMove].frame
      }
      if (_startFrom && _startFromNthMove) {
        if (!moves)
          throw Error(
            'moves is not defined. This is likely not a parsed combo clip',
          )
        const moveFrame =
          _startFromNthMove > -1
            ? moves[_startFromNthMove].frame
            : moves[moves.length + _startFromNthMove].frame
        _startFrame =
          startFrom > -1
            ? frames[moveFrame + _startFrom].frame
            : frames[moveFrame + _startFrom].frame
      }
      if (!_startFrom && !_startFromNthMove) {
        _startFrame = moves[0].frame
      }

      let comboerStates
      let comboeeStates
      if (comboerActionState) {
        comboerStates = actionStates.find(
          (s) => s.id == comboerActionState,
        ).actionStateID
      }
      comboerStates = Array.isArray(comboerStates)
        ? comboerStates
        : [comboerStates]
      if (comboeeActionState) {
        comboeeStates = actionStates.find(
          (s) => s.id == comboeeActionState,
        ).actionStateID
      }
      comboeeStates = Array.isArray(comboeeStates)
        ? comboeeStates
        : [comboeeStates]

      let found = false
      for (
        let i = _startFrame;
        _searchRange > -1
          ? i <= _startFrame + _searchRange && i < lastFrame - 1
          : i >= _startFrame + _searchRange;
        _searchRange > -1 ? i++ : i--
      ) {
        const currentFrame = frames[i.toString()]
        if (!currentFrame) return false
        let _comboer
        let _comboee
        if (comboerActionState)
          _comboer = currentFrame.players.find(
            (p) => p && p.post.playerIndex == comboer.playerIndex,
          )
        if (comboeeActionState)
          _comboee = currentFrame.players.find(
            (p) => p && p.post.playerIndex == comboee.playerIndex,
          )

        if (comboerActionState && comboeeActionState) {
          if (
            comboerStates.indexOf(_comboer.post.actionStateId) != -1 &&
            comboeeStates.indexOf(_comboee.post.actionStateId) != -1
          ) {
            found = true
            break
          }
        } else if (comboerActionState) {
          if (comboerStates.indexOf(_comboer.post.actionStateId) != -1) {
            found = true
            break
          }
        } else if (comboeeActionState) {
          if (comboeeStates.indexOf(_comboee.post.actionStateId) != -1) {
            found = true
            break
          }
        }
      }
      if (exclude) {
        return !found
      }
      return found
    })
}
