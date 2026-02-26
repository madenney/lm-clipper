import type {
  FramesType,
  GameStartType,
  PostFrameUpdateType,
} from '@slippi/slippi-js'
import type {
  ComboType,
  MoveLandedType,
  PlayerIndexedType,
} from '@slippi/slippi-js/dist/stats/common'

const DEFAULT_COMBO_TIMEOUT = 45

// Action state range checks — ported from slippi-js common.esm.js

function isDamaged(state: number): boolean {
  return (
    (state >= 75 && state <= 91) ||
    state === 38 ||
    state === 185 ||
    state === 193
  )
}

function isGrabbed(state: number): boolean {
  return state >= 223 && state <= 232
}

function isCommandGrabbed(state: number): boolean {
  return (
    ((state >= 266 && state <= 304) || (state >= 327 && state <= 338)) &&
    state !== 293
  )
}

function isTeching(state: number): boolean {
  return state >= 199 && state <= 204
}

function isDown(state: number): boolean {
  return state >= 183 && state <= 198
}

function isDead(state: number): boolean {
  return state >= 0 && state <= 10
}

function didLoseStock(
  frame: PostFrameUpdateType,
  prevFrame: PostFrameUpdateType,
): boolean {
  if (!frame || !prevFrame) return false
  return (prevFrame.stocksRemaining ?? 0) - (frame.stocksRemaining ?? 0) > 0
}

function calcDamageTaken(
  frame: PostFrameUpdateType,
  prevFrame: PostFrameUpdateType,
): number {
  return (frame.percent ?? 0) - (prevFrame.percent ?? 0)
}

function getSinglesPlayerPermutations(
  settings: GameStartType,
): PlayerIndexedType[] {
  if (!settings || settings.players.length !== 2) return []
  return [
    {
      playerIndex: settings.players[0].playerIndex,
      opponentIndex: settings.players[1].playerIndex,
    },
    {
      playerIndex: settings.players[1].playerIndex,
      opponentIndex: settings.players[0].playerIndex,
    },
  ]
}

// Per-permutation combo tracking state

interface ComboState {
  combo: ComboType | null
  move: MoveLandedType | null
  resetCounter: number
  lastHitAnimation: number | null
}

function handleComboCompute(
  frames: FramesType,
  state: ComboState,
  indices: PlayerIndexedType,
  frame: { frame: number; players: any },
  combos: ComboType[],
  comboTimeoutFrames: number,
): void {
  const currentFrameNumber = frame.frame
  const playerFrame = frame.players[indices.playerIndex]?.post
  const opponentFrame = frame.players[indices.opponentIndex]?.post
  if (!playerFrame || !opponentFrame) return

  const prevFrameNumber = currentFrameNumber - 1
  let prevPlayerFrame: PostFrameUpdateType | null = null
  let prevOpponentFrame: PostFrameUpdateType | null = null

  if (frames[prevFrameNumber]) {
    prevPlayerFrame =
      frames[prevFrameNumber].players[indices.playerIndex]?.post ?? null
    prevOpponentFrame =
      frames[prevFrameNumber].players[indices.opponentIndex]?.post ?? null
  }

  const oppActionStateId = opponentFrame.actionStateId!
  const opntIsDamaged = isDamaged(oppActionStateId)
  const opntIsGrabbed = isGrabbed(oppActionStateId)
  const opntIsCommandGrabbed = isCommandGrabbed(oppActionStateId)
  const opntDamageTaken = prevOpponentFrame
    ? calcDamageTaken(opponentFrame, prevOpponentFrame)
    : 0

  // Track whether the attacker's action state changed since the last hit.
  // Prevents multi-hit moves (e.g. fox drill) from counting as multiple moves.
  // The actionStateCounter check handles rapid same-move repeats (e.g. ganon jab).
  const actionChangedSinceHit =
    playerFrame.actionStateId !== state.lastHitAnimation
  const actionCounter = playerFrame.actionStateCounter ?? 0
  const prevActionCounter = prevPlayerFrame
    ? (prevPlayerFrame.actionStateCounter ?? 0)
    : 0
  const actionFrameCounterReset = actionCounter < prevActionCounter

  if (actionChangedSinceHit || actionFrameCounterReset) {
    state.lastHitAnimation = null
  }

  // If opponent took damage and is in stun, start or extend a combo
  if (opntIsDamaged || opntIsGrabbed || opntIsCommandGrabbed) {
    if (!state.combo) {
      state.combo = {
        playerIndex: indices.opponentIndex,
        startFrame: currentFrameNumber,
        endFrame: null,
        startPercent: prevOpponentFrame ? (prevOpponentFrame.percent ?? 0) : 0,
        currentPercent: opponentFrame.percent ?? 0,
        endPercent: null,
        moves: [],
        didKill: false,
        lastHitBy: indices.playerIndex,
      } as ComboType
      combos.push(state.combo)
    }

    if (opntDamageTaken) {
      if (state.lastHitAnimation === null) {
        state.move = {
          playerIndex: indices.playerIndex,
          frame: currentFrameNumber,
          moveId: playerFrame.lastAttackLanded!,
          hitCount: 0,
          damage: 0,
        }
        state.combo!.moves.push(state.move)
      }

      if (state.move) {
        state.move.hitCount += 1
        state.move.damage += opntDamageTaken
      }

      // Store previous frame animation to handle trades
      state.lastHitAnimation = prevPlayerFrame
        ? prevPlayerFrame.actionStateId
        : null
    }
  }

  if (!state.combo) return

  const opntIsTeching = isTeching(oppActionStateId)
  const opntIsDowned = isDown(oppActionStateId)
  const opntDidLoseStock =
    prevOpponentFrame && didLoseStock(opponentFrame, prevOpponentFrame)
  const opntIsDying = isDead(oppActionStateId)

  // Update current percent unless opponent lost a stock
  if (!opntDidLoseStock) {
    state.combo.currentPercent = opponentFrame.percent ?? 0
  }

  if (
    opntIsDamaged ||
    opntIsGrabbed ||
    opntIsCommandGrabbed ||
    opntIsTeching ||
    opntIsDowned ||
    opntIsDying
  ) {
    state.resetCounter = 0
  } else {
    state.resetCounter += 1
  }

  let shouldTerminate = false

  // Termination condition 1: opponent lost a stock
  if (opntDidLoseStock) {
    state.combo.didKill = true
    shouldTerminate = true
  }

  // Termination condition 2: combo reset timeout
  if (state.resetCounter > comboTimeoutFrames) {
    shouldTerminate = true
  }

  if (shouldTerminate) {
    state.combo.endFrame = playerFrame.frame
    state.combo.endPercent = prevOpponentFrame
      ? (prevOpponentFrame.percent ?? 0)
      : 0
    state.combo = null
    state.move = null
  }
}

/**
 * Detect combos from raw frame data. Drop-in replacement for
 * `game.getStats().combos` with a configurable timeout.
 *
 * @param frames      - All frames from `game.getFrames()`
 * @param settings    - Game settings from `game.getSettings()`
 * @param comboTimeoutFrames - Frames opponent must be out of hitstun
 *                             before the combo ends (default 45)
 */
export function detectCombos(
  frames: FramesType,
  settings: GameStartType,
  comboTimeoutFrames: number = DEFAULT_COMBO_TIMEOUT,
): ComboType[] {
  const permutations = getSinglesPlayerPermutations(settings)
  if (permutations.length === 0) return []

  const combos: ComboType[] = []
  const stateMap = new Map<PlayerIndexedType, ComboState>()

  permutations.forEach((indices) => {
    stateMap.set(indices, {
      combo: null,
      move: null,
      resetCounter: 0,
      lastHitAnimation: null,
    })
  })

  // Walk every frame in order
  const frameNumbers = Object.keys(frames)
    .map(Number)
    .sort((a, b) => a - b)

  for (const frameNum of frameNumbers) {
    const frame = frames[frameNum]
    permutations.forEach((indices) => {
      const state = stateMap.get(indices)!
      handleComboCompute(
        frames,
        state,
        indices,
        frame,
        combos,
        comboTimeoutFrames,
      )
    })
  }

  return combos
}
