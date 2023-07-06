export interface ConfigInterface {
  lastArchivePath: string
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
}

export interface PlayerInterface {
  playerIndex: number
  port: number
  characterId: number | null
  characterColor: number | null
  nametag: string
  displayName: string
}

export interface FileInterface {
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
  generateJSON(): void
}

export interface ClipInterface {
  startFrame: number
  endFrame: number
  path: string
  recordingParams: { [key: string]: any }
}

export interface FilterInterface {
  type: string
  label: string
  params: { [key: string]: any }
  results: ClipInterface[] | FileInterface[]
  generateJSON?(): void
}

export interface EventEmitterInterface {
  // eslint-disable-next-line no-unused-vars
  (arg1: { current: number; total: number }): void
}

export interface ShallowFilterInterface {
  type: string
  label: string
  params: { [key: string]: any }
  results: number
}

export interface ShallowArchiveInterface {
  path: string
  name: string
  createdAt: number
  updatedAt: number
  files: number
  filters: ShallowFilterInterface[]
}

export interface ArchiveInterface {
  path: string
  name: string
  createdAt: number
  updatedAt: number
  files: FileInterface[]
  filters: FilterInterface[]
  save?(): void
  shallowCopy?(): ShallowArchiveInterface
  addFiles?(
    // eslint-disable-next-line no-unused-vars
    filePaths: string | string[],
    // eslint-disable-next-line no-unused-vars
    eventEmitter: EventEmitterInterface
    // eslint-disable-next-line no-unused-vars
    // eventEmitter: (arg1: { current: number; total: number }) => void
  ): number
}
