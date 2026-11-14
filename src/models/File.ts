import { openReplayHeader } from '../lib/slippiGame'
import { FileInterface } from '../constants/types'
import { GAME_START_FRAME } from '../constants/frames'
import { CPU_PLAYER_TYPE } from '../lib/cpuPlayers'
import { readLastFrame } from '../lib/lastFrame'

/** The last frame from the end of the raw stream (lib/lastFrame.ts), or
 *  undefined when it can't be read. Never fails the import. */
function lastFrameFromStream(path: string): number | undefined {
  try {
    return readLastFrame(path) ?? undefined
  } catch {
    return undefined
  }
}

export function fileProcessor(path: string) {
  // Settings and metadata only (a .slpz isn't decompressed for this).
  const game = openReplayHeader(path)
  const fileJSON: FileInterface = {
    path,
    id: '',
    players: [],
    winner: 0,
    stage: 0,
    startedAt: 0,
    lastFrame: GAME_START_FRAME,
    isValid: false,
    isProcessed: true,
    info: '',
    startFrame: GAME_START_FRAME,
    endFrame: 0,
  }

  // check settings for indicators of invalid game
  const settings = game.getSettings()
  if (!settings) {
    fileJSON.isValid = false
    fileJSON.info = 'Bad settings'
    return fileJSON
  }
  if (settings.isTeams) {
    fileJSON.isValid = false
    fileJSON.info = 'teams'
    return fileJSON
  }
  if (settings.players.length !== 2) {
    fileJSON.isValid = false
    fileJSON.info = '!2 players'
    return fileJSON
  }

  // stage check
  if (!settings.stageId) {
    fileJSON.isValid = false
    fileJSON.info = 'Invalid stage'
    return fileJSON
  }
  // Games with a CPU player are imported and marked (players[].cpu); the
  // Game Filter leaves them out unless "Include CPU games" is on.
  const p1 = settings.players[0]
  const p2 = settings.players[1]

  // check metadata for indicators of invalid game
  const metadata = game.getMetadata()

  if (!metadata) {
    fileJSON.isValid = false
    fileJSON.info = 'Bad metadata'
    return fileJSON
  }

  const emptyObject = {}
  if (JSON.stringify(emptyObject) === JSON.stringify(metadata)) {
    // Anonymized replays (e.g. ranked) carry no metadata at all: read the last
    // frame from the end of the replay instead, so the game has a duration.
    // Their validity rules are unchanged (no 20-second check, as before).
    fileJSON.info = 'Metadata removed'
    const lastFrame = lastFrameFromStream(path)
    if (lastFrame !== undefined) fileJSON.lastFrame = lastFrame
  } else {
    // A metadata block without lastFrame: the replay itself still knows.
    const metaLastFrame =
      metadata.lastFrame || (metadata.startAt && lastFrameFromStream(path))
    if (!metaLastFrame || !metadata.startAt) {
      fileJSON.isValid = false
      fileJSON.info = 'No lastFrame in metadata'
      return fileJSON
    }
    const length = metaLastFrame / 60
    if (Number.isNaN(length)) {
      fileJSON.isValid = false
      fileJSON.info = 'No length'
      return fileJSON
    }
    if (length < 20) {
      fileJSON.isValid = false
      fileJSON.info = 'Game Length < 20 seconds'
      return fileJSON
    }

    fileJSON.startedAt = Math.floor(new Date(metadata.startAt).getTime() / 1000)
    fileJSON.lastFrame = metaLastFrame
  }

  fileJSON.isValid = true
  fileJSON.stage = settings.stageId
  fileJSON.players = [
    {
      playerIndex: p1.playerIndex,
      port: p1.port,
      characterId: p1.characterId!,
      characterColor: p1.characterColor!,
      nametag: p1.nametag ? p1.nametag : '',
      displayName: p1.displayName,
      connectCode: p1.connectCode || '',
      cpu: p1.type === CPU_PLAYER_TYPE,
    },
    {
      playerIndex: p2.playerIndex,
      port: p2.port,
      characterId: p2.characterId!,
      characterColor: p2.characterColor!,
      nametag: p2.nametag ? p2.nametag : '',
      displayName: p2.displayName,
      connectCode: p2.connectCode || '',
      cpu: p2.type === CPU_PLAYER_TYPE,
    },
  ]
  return fileJSON
}
