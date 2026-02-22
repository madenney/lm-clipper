/* eslint-disable no-unused-vars */
export interface RecentProject {
  name: string
  path: string
  lastOpened: number
}

export interface ConfigInterface {
  recentProjects: RecentProject[]
  outputPath: string
  lastArchivePath: string | null
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
  resolution: number
  playbackResolution: number
  bitrateKbps: number
  addStartFrames: number
  addEndFrames: number
  lastClipOffset: number
  numCPUs: number
  numFilterThreads: number
  slice: number
  dolphinCutoff: number
  ssbmIsoPath: string
  dolphinPath: string
  concatenate: boolean
  convertToMp4: boolean
  detectDuplicatesOnImport: boolean
  testMode?: boolean
  [key: string]: any
}

export interface PlayerInterface {
  playerIndex: number
  port: number
  characterId: number
  characterColor: number
  nametag: string
  displayName: string
  connectCode: string
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
  // generateJSON?(): void
}

export interface ClipInterface {
  startFrame: number
  endFrame: number
  path: string
  stage: number
  startedAt?: number
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

export interface LiteItem {
  id: string
  stage: number
  path?: string
  players?: PlayerInterface[]
  startFrame?: number
  endFrame?: number
}

export interface EventEmitterInterface {
  (arg1: { current: number; total: number; newItemCount?: number }): void
}

export interface FilterInterface {
  id: string
  type: string
  label: string
  isProcessed: boolean
  params: { [key: string]: any }
  results: number
  resumable?: boolean
  run3?(
    dbPath: string,
    prevTable: string,
    numFilterThreads: number,
    arg2: EventEmitterInterface,
    abortSignal?: AbortSignal,
    options?: { resume?: boolean },
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
  resumable?: boolean
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
  // save?(): void
  runFilter?(
    filterId: string,
    numFilterThreads: number,
    filterMsgEventEmitter: EventEmitterInterface,
  ): void
  runFilters?(
    numFilterThreads: number,
    currentFilterEventEmitter: EventEmitterInterface,
    filterMsgEventEmitter: EventEmitterInterface,
  ): void
  getNames?(): Promise<{ name: string; total: number }[]>
  getConnectCodes?(): Promise<{ name: string; total: number }[]>
  shallowCopy?(): Promise<ShallowArchiveInterface>
  addFiles?(
    filePaths: string | string[],
    eventEmitter: EventEmitterInterface,
    options?: {
      detectDuplicates?: boolean
      abortSignal?: AbortSignal
      maxWorkers?: number
    },
  ): Promise<boolean>
  getItems?(params: {
    filterId: string
    numPerPage?: number
    currentPage?: number
    offset?: number
    limit?: number
    lite?: boolean
  }): Promise<ClipInterface[] | FileInterface[] | LiteItem[]>
  getAllItems?(filterId: string): Promise<ClipInterface[] | FileInterface[]>
  addFilter?(newFilterJSON: FilterInterface): Promise<ArchiveInterface>
  deleteFilter?(filterId: string): Promise<ArchiveInterface>
  saveMetaData?(): Promise<void>
  resetFiltersFrom?(startIndex: number): Promise<void>
}

export interface ReplayInterface {
  index: number
  path: string
  startFrame: number
  endFrame: number
}

export type WorkerMessage =
  | WorkerMessageProgress
  | WorkerMessageDone
  | WorkerMessageError

interface WorkerMessageProgress {
  type: 'progress'
  current: number
  total: number
  results?: number
}

interface WorkerMessageDone {
  type: 'done'
  results: number
}

interface WorkerMessageError {
  type: 'error'
  message: string
  filterType: string
  itemIndex?: number
}
