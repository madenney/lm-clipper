import type {
  ClipInterface,
  FileInterface,
  PlayerInterface,
  LiteItem,
} from '../../../constants/types'

export type ClipData = ClipInterface | FileInterface | LiteItem

/**
 * Extract player info from various data shapes
 */
export const getPlayers = (
  data: ClipData,
): [PlayerInterface | undefined, PlayerInterface | undefined] => {
  if ('comboer' in data && data.comboer) {
    return [data.comboer, data.comboee]
  }
  if ('players' in data && data.players) {
    return [data.players[0], data.players[1]]
  }
  return [undefined, undefined]
}

/**
 * Get clip payload for play/record actions
 */
export const getClipPayload = (data: ClipData) => {
  if (!('path' in data) || typeof data.path !== 'string') return null

  const payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  } = { path: data.path }

  if ('startFrame' in data && typeof data.startFrame === 'number') {
    payload.startFrame = data.startFrame
  }
  if ('endFrame' in data && typeof data.endFrame === 'number') {
    payload.endFrame = data.endFrame
  }
  if (
    'lastFrame' in data &&
    typeof (data as FileInterface).lastFrame === 'number'
  ) {
    payload.lastFrame = (data as FileInterface).lastFrame
  }

  return payload
}

/**
 * Calculate duration display string
 */
export const getDurationDisplay = (data: ClipData): string | null => {
  let frames = 0

  if ('endFrame' in data && 'startFrame' in data) {
    const clip = data as ClipInterface
    if (
      typeof clip.endFrame === 'number' &&
      typeof clip.startFrame === 'number'
    ) {
      frames = clip.endFrame - clip.startFrame
    }
  } else if ('lastFrame' in data) {
    const file = data as FileInterface
    if (typeof file.lastFrame === 'number' && file.lastFrame > 0) {
      frames = file.lastFrame
    }
  }

  if (!frames) return null

  const seconds = frames / 60
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }
  return `${seconds.toFixed(1)}s`
}
