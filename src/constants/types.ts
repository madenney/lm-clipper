/* eslint-disable no-unused-vars */
export interface ConfigInterface {
  lastArchivePath: string|null
  hideHud: boolean
  gameMusic: boolean
  enableChants: boolean
  disableScreenShake: boolean
  hideTags: boolean
  hideNames: boolean
  overlaySource: boolean
  fixedCamera: boolean
  noElectricSFX: boolean
  noCrowdNoise: boolean
  disableMagnifyingGlass: boolean
  shuffle: boolean
  resolution: string
  bitrateKbps: number
  addStartFrames: number
  addEndFrames: number
  lastClipOffset: number
  numCPUs: number
  slice: number
  dolphinCutoff: number
  ssbmIsoPath: string
  dolphinPath: string
  outputPath: string
  [key: string]: any
}

export interface PlayerInterface {
  playerIndex: number
  port: number
  characterId: number
  characterColor: number
  nametag: string
  displayName: string
}

export interface FileInterface {
  id: string
  players: PlayerInterface[]
  startedAt: number
  winner: number
  stage: number
  lastFrame: number
  path: string
  isValid: boolean
  isProcessed: boolean
  info: string
  startFrame: number
  endFrame: number
  generateJSON?(): void
}

export interface ClipInterface {
  startFrame: number
  endFrame: number
  path: string
  stage: number
  comboer?: PlayerInterface
  comboee?: PlayerInterface
  players?: PlayerInterface[]
  combo?: {
    startPercent: number
    endPercent: number | null | undefined
    didKill: boolean
    moves?: {
      playerIndex: number
      frame: number
      moveId: number
      hitCount: number
      damage: number
    }[]
  }
  recordingParams?: { [key: string]: any }
}

export interface EventEmitterInterface {
  (arg1: { current: number; total: number }): void
}

export interface FilterInterface {
  id: string
  type: string
  label: string
  isProcessed: boolean
  params: { [key: string]: any }
  results: ClipInterface[] | FileInterface[]
  run2?(
    prevTable: string,
    numFilterThreads: number,
    arg2: EventEmitterInterface
  ): void
  run?(
    arg1: ClipInterface[] | FileInterface[],
    numFilterThreads: number,
    arg2: EventEmitterInterface
  ): boolean
  generateJSON?(): void
}

export interface ShallowFilterInterface {
  id: string
  type: string
  label: string
  isProcessed: boolean
  params: { [key: string]: any }
  results: number
}

export interface ShallowArchiveInterface {
  path: string
  name: string
  createdAt: number
  totalFiles: number
  validFiles: number
  filters: ShallowFilterInterface[]
}

export interface ArchiveInterface {
  path: string
  name: string
  createdAt: number
  files: FileInterface[]
  filters: FilterInterface[]
  save?(): void
  runFilter?(
    filterId: string,
    numFilterThreads: number,
    filterMsgEventEmitter: EventEmitterInterface
  ): void
  runFilters?(
    numFilterThreads: number,
    currentFilterEventEmitter: EventEmitterInterface,
    filterMsgEventEmitter: EventEmitterInterface
  ): void
  names?(): { name: string; total: number }[]
  shallowCopy?(): ShallowArchiveInterface
  addFiles?(
    filePaths: string | string[],
    eventEmitter: EventEmitterInterface
  ): number
}

export interface ReplayInterface {
  index: number
  path: string
  startFrame: number
  endFrame: number
}

export type WorkerMessage = WorkerMessageProgress | WorkerMessageResults

interface WorkerMessageProgress {
  type: 'progress'
  current: number
  total: number
}

interface WorkerMessageResults {
  type: 'results'
  results: FileInterface[] | ClipInterface[]
}
