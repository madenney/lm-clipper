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

export interface PlayerInterface {}

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
  recordingParams: {}
}

export interface FilterInterface {
  id: string
  params: {}
  results: ClipInterface[] | FileInterface[]
  generateJSON(): void
}

export interface ArchiveInterface {
  path: string
  name: string
  createdAt: number
  updatedAt: number
  files: FileInterface[]
  filters: FilterInterface[]
  save?(): void
}

export interface ShallowFilterInterface {
  id: string
  params: {}
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
