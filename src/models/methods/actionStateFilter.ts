/* eslint-disable eqeqeq */
/* eslint-disable no-plusplus */
/* eslint-disable no-underscore-dangle */
import { SlippiGame } from '@slippi/slippi-js'
import { actionStates } from '../../constants/actionStates'

const resolveStates = (ids, customIds) => {
  if (!ids) return []
  const arr = Array.isArray(ids) ? ids : [ids]
  if (arr.length === 0) return []
  return arr.flatMap((id) => {
    if (id === 'custom' || id == 'custom') return customIds || []
    const s = actionStates.find((a) => a.id == id)
    if (!s) return []
    return Array.isArray(s.actionStateID) ? s.actionStateID : [s.actionStateID]
  })
}

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
      const hasParsedData = !!(comboer && comboee && combo)
      const moves = combo?.moves
      const {
        startFrom,
        searchRange,
        comboerActionState,
        comboeeActionState,
        startFromNthMove,
        offset,
        comboerCustomIds,
        comboeeCustomIds,
        exclude,
        comboerMinX,
        comboerMaxX,
        comboerMinY,
        comboerMaxY,
        comboeeMinX,
        comboeeMaxX,
        comboeeMinY,
        comboeeMaxY,
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
      const _searchRange = parseInt(searchRange, 10)

      // Parse position dropdown value — take first valid index
      const _startFromNthMove = startFromNthMove
        ? String(startFromNthMove)
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '__custom__' && s !== 'e' && s !== '')
            .map((s) => parseInt(s, 10))
            .find((n) => !Number.isNaN(n))
        : undefined

      let _startFrame

      if (_startFromNthMove != null && moves && moves.length > 0) {
        const mi = _startFromNthMove >= 0 ? _startFromNthMove : moves.length + _startFromNthMove
        _startFrame = moves[mi]?.frame ?? moves[0].frame
      } else if (_startFrom) {
        _startFrame =
          _startFrom > -1
            ? frames[startFrame + _startFrom]?.frame
            : frames[endFrame + _startFrom]?.frame
      } else if (moves && moves.length > 0) {
        _startFrame = moves[0].frame
      } else {
        _startFrame = startFrame || -123
      }

      const _offset = parseInt(offset, 10)
      if (_offset) _startFrame += _offset

      const p1CustomIds = comboerCustomIds
        ? String(comboerCustomIds).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
        : []
      const p2CustomIds = comboeeCustomIds
        ? String(comboeeCustomIds).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
        : []
      const p1States = resolveStates(comboerActionState, p1CustomIds)
      const p2States = resolveStates(comboeeActionState, p2CustomIds)
      const hasP1 = p1States.length > 0
      const hasP2 = p2States.length > 0

      // Position bounds
      const _comboerMinX = parseInt(comboerMinX, 10)
      const _comboerMaxX = parseInt(comboerMaxX, 10)
      const _comboerMinY = parseInt(comboerMinY, 10)
      const _comboerMaxY = parseInt(comboerMaxY, 10)
      const _comboeeMinX = parseInt(comboeeMinX, 10)
      const _comboeeMaxX = parseInt(comboeeMaxX, 10)
      const _comboeeMinY = parseInt(comboeeMinY, 10)
      const _comboeeMaxY = parseInt(comboeeMaxY, 10)
      const hasP1Pos =
        !Number.isNaN(_comboerMinX) ||
        !Number.isNaN(_comboerMaxX) ||
        !Number.isNaN(_comboerMinY) ||
        !Number.isNaN(_comboerMaxY)
      const hasP2Pos =
        !Number.isNaN(_comboeeMinX) ||
        !Number.isNaN(_comboeeMaxX) ||
        !Number.isNaN(_comboeeMinY) ||
        !Number.isNaN(_comboeeMaxY)

      const checkPos = (post, minX, maxX, minY, maxY) => {
        const x = post.positionX
        const y = post.positionY
        if (!Number.isNaN(minX) && x < minX) return false
        if (!Number.isNaN(maxX) && x > maxX) return false
        if (!Number.isNaN(minY) && y < minY) return false
        if (!Number.isNaN(maxY) && y > maxY) return false
        return true
      }

      if (!hasP1 && !hasP2 && !hasP1Pos && !hasP2Pos) return false

      // Whether each role has any constraint (state or position)
      const needP1 = hasP1 || hasP1Pos
      const needP2 = hasP2 || hasP2Pos

      const matchP1 = (post) => {
        if (hasP1 && p1States.indexOf(post.actionStateId) == -1) return false
        if (hasP1Pos && !checkPos(post, _comboerMinX, _comboerMaxX, _comboerMinY, _comboerMaxY)) return false
        return true
      }
      const matchP2 = (post) => {
        if (hasP2 && p2States.indexOf(post.actionStateId) == -1) return false
        if (hasP2Pos && !checkPos(post, _comboeeMinX, _comboeeMaxX, _comboeeMinY, _comboeeMaxY)) return false
        return true
      }

      let found = false
      const searchAll = !_searchRange
      for (
        let i = _startFrame;
        searchAll
          ? i < lastFrame - 1
          : _searchRange > 0
            ? i < _startFrame + _searchRange && i < lastFrame - 1
            : i > _startFrame + _searchRange;
        searchAll ? i++ : _searchRange > 0 ? i++ : i--
      ) {
        const currentFrame = frames[i.toString()]
        if (!currentFrame) continue
        const players = currentFrame.players?.filter((p) => p?.post) || []

        if (hasParsedData) {
          // Parsed mode: match by comboer/comboee player index
          const comboerPlayer = players.find((p) => p.post.playerIndex == comboer.playerIndex)
          const comboeePlayer = players.find((p) => p.post.playerIndex == comboee.playerIndex)
          const p1Ok = !needP1 || (comboerPlayer && matchP1(comboerPlayer.post))
          const p2Ok = !needP2 || (comboeePlayer && matchP2(comboeePlayer.post))
          if (p1Ok && p2Ok) {
            found = true
            break
          }
        } else {
          // Unparsed mode: check any player / any arrangement
          if (needP1 && needP2) {
            for (let a = 0; a < players.length; a++) {
              for (let b = 0; b < players.length; b++) {
                if (a === b) continue
                if (matchP1(players[a].post) && matchP2(players[b].post)) {
                  found = true
                  break
                }
              }
              if (found) break
            }
            if (found) break
          } else {
            const match = needP1 ? matchP1 : matchP2
            if (players.some((p) => match(p.post))) {
              found = true
              break
            }
          }
        }
      }
      if (exclude) {
        return !found
      }
      return found
    })
}
