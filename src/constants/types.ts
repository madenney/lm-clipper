/* eslint-disable no-unused-vars */
export interface ConfigInterface {
  outputPath: string
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
  //generateJSON?(): void
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
  (arg1: { current: number; total: number, newItem?: FileInterface | ClipInterface }): void
}

export interface FilterInterface {
  id: string
  type: string
  label: string
  isProcessed: boolean
  params: { [key: string]: any }
  results: number
  run3?(
    dbPath: string,
    prevTable: string,
    numFilterThreads: number,
    arg2: EventEmitterInterface
  ): void
  // run?(
  //   arg1: ClipInterface[] | FileInterface[],
  //   numFilterThreads: number,
  //   arg2: EventEmitterInterface
  // ): boolean
  delete?(dbPath: string): Promise<void>
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
  files: number
  filters: ShallowFilterInterface[]
}

export interface ArchiveInterface {
  path: string
  name: string
  createdAt: number
  files: number
  filters: FilterInterface[]
  //save?(): void
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
  getNames?(): Promise<{ name: string; total: number }[]>
  shallowCopy?(): Promise<ShallowArchiveInterface>
  addFiles?(
    filePaths: string | string[],
    eventEmitter: EventEmitterInterface
  ): Promise<void>
  getItems?(params: {
    filterId: string,
    numPerPage: number,
    currentPage: number
  }): Promise<ClipInterface[]|FileInterface>
  addFilter?(type: string): Promise<ArchiveInterface>
  deleteFilter?(filterId: string): Promise<ArchiveInterface>
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
