import { SlippiGame } from '@slippi/slippi-js'
import { FileInterface } from '../constants/types'

export function fileProcessor(path: string) {
  const game = new SlippiGame(path)
  const fileJSON: FileInterface = {
    path,
    id: '',
    players: [],
    winner: 0,
    stage: 0,
    startedAt: 0,
    lastFrame: -123,
    isValid: false,
    isProcessed: true,
    info: '',
    startFrame: -123,
    endFrame: 0
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
  // bot check
  const p1 = settings.players[0]
  const p2 = settings.players[1]
  if (p1.type === 1 || p2.type === 1) {
    fileJSON.isValid = false
    fileJSON.info = 'Bot'
    return fileJSON
  }

  // check metadata for indicators of invalid game
  const metadata = game.getMetadata()

  if(!metadata){
    fileJSON.isValid = false
    fileJSON.info = 'Bad metadata'
    return fileJSON
  }

  const emptyObject = {}
  if(JSON.stringify(emptyObject) == JSON.stringify(metadata)){
    fileJSON.info = 'Metadata removed'

  } else {
    if (!metadata.lastFrame || !metadata.startAt) {
      fileJSON.isValid = false
      fileJSON.info = 'No lastFrame in metadata'
      return fileJSON
    }
    const length = metadata.lastFrame / 60
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

    fileJSON.startedAt = Math.floor(new Date(metadata.startAt).getTime()/1000)
    fileJSON.lastFrame = metadata.lastFrame
  }

  fileJSON.isValid = true
  fileJSON.stage = settings.stageId
  fileJSON.players = [
    {
      playerIndex: p1.playerIndex,
      port: p1.port,
      characterId: p1.characterId,
      characterColor: p1.characterColor,
      nametag: p1.nametag ? p1.nametag : '',
      displayName: p1.displayName,
    },
    {
      playerIndex: p2.playerIndex,
      port: p2.port,
      characterId: p2.characterId,
      characterColor: p2.characterColor,
      nametag: p2.nametag ? p2.nametag : '',
      displayName: p2.displayName,
    },
  ]
  return fileJSON
}
