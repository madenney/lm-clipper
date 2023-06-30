import { FileInterface, PlayerInterface } from '../constants/types'

export default class File {
  id: string
  players: PlayerInterface[]
  startedAt: string
  winner: number
  stage: number
  lastFrame: number
  path: string
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
