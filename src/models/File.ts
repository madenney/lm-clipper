import { SlippiGame } from '@slippi/slippi-js'
import { FileInterface, PlayerInterface } from '../constants/types'

export default class File {
  path: string
  id: string
  players: PlayerInterface[]
  startedAt: string
  winner: number
  stage: number
  lastFrame: number
  isValid: boolean
  isProcessed: boolean
  info: string
  constructor(fileJSON: FileInterface) {
    this.id = fileJSON.id
    this.players = fileJSON.players
    this.startedAt = fileJSON.startedAt
    this.winner = fileJSON.winner
    this.stage = fileJSON.stage
    this.lastFrame = fileJSON.lastFrame
    this.path = fileJSON.path
    this.isValid = fileJSON.isValid
    this.isProcessed = fileJSON.isProcessed
    this.info = fileJSON.info
  }

  generateJSON() {
    return {
      id: this.id,
      players: this.players,
      stage: this.stage,
      startedAt: this.startedAt,
      lastFrame: this.lastFrame,
      path: this.path,
      isValid: this.isValid,
      isProcessed: this.isProcessed,
      info: this.info,
    }
  }
}

export function fileProcessor(path: string) {
  const game = new SlippiGame(path)
  const fileJSON: FileInterface = {
    path,
    id: '',
    players: [],
    winner: 0,
    stage: 0,
    startedAt: '',
    lastFrame: 0,
    isValid: false,
    isProcessed: true,
    info: '',
    generateJSON: () => {},
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
  // if (
  //   legalStages.map((stage: any) => stage.id).indexOf(settings.stageId) === -1
  // ) {
  //   fileJSON.isValid = false
  //   fileJSON.info = 'Illegal stage'
  //   return fileJSON
  // }

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
  if (!metadata || !metadata.lastFrame || !metadata.startAt) {
    fileJSON.isValid = false
    fileJSON.info = 'Bad metadata'
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

  fileJSON.isValid = true
  fileJSON.startedAt = metadata.startAt
  fileJSON.lastFrame = metadata.lastFrame
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
