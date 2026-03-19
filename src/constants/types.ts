/* eslint-disable no-unused-vars */

// ---------------------------------------------------------------------------
// Filter Param Types
// ---------------------------------------------------------------------------

export type FilesFilterParams = {
  stage?: (string | number)[]
  char1?: (string | number)[]
  char2?: (string | number)[]
  player1?: string[] | string
  player2?: string[] | string
  player1CC?: string[] | string
  player2CC?: string[] | string
  maxFiles?: string
}

export type SlpParserParams = {
  minHits?: string
  maxHits?: string
  maxFiles?: string
  comboTimeout?: string
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
  didKill?: boolean
}

export type ComboFilterParams = {
  minHits?: string
  maxHits?: string
  minDamage?: string
  comboerChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeChar?: (string | number)[]
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
  comboStage?: (string | number)[]
  didKill?: boolean
  countPummels?: boolean
  nthMoves?: NthMoveDef[]
}

export type NthMoveDef = {
  n: string
  moveId?: (string | number)[]
  t?: string
  tMin?: string
  d?: string
  dMax?: string
}

export type ActionStateFilterParams = {
  maxFiles?: string
  startFrom?: string
  searchRange?: string
  startFromNthMove?: string
  offset?: string
  comboerActionState?: (string | number)[]
  comboeeActionState?: (string | number)[]
  comboerCustomIds?: string
  comboeeCustomIds?: string
  exclude?: boolean
  comboerMinX?: string
  comboerMaxX?: string
  comboerMinY?: string
  comboerMaxY?: string
  comboeeMinX?: string
  comboeeMaxX?: string
  comboeeMinY?: string
  comboeeMaxY?: string
}

export type EdgeguardParams = {
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
  stageFilter?: (string | number)[]
}

export type ZeroToDeathsParams = {
  startThreshold?: string
}

export type AfkDetectionParams = {
  maxInputsPerSec?: string
  exclude?: boolean
}

export type KoDirectionParams = {
  maxFiles?: string
  direction?: string[]
}

export type RemoveStarKOFramesParams = {
  maxFiles?: string
}

export type DeduplicateParams = Record<string, never>

export type TrimParams = {
  addStartFrames?: string
  addEndFrames?: string
}

export type ReverseParams = {
  maxFiles?: string
  n?: string
}

export type SortParams = {
  sortFunction?: string
  reverse?: boolean
}

export type CustomParams = Record<string, any>

export type FilterParams =
  | FilesFilterParams
  | SlpParserParams
  | ComboFilterParams
  | ActionStateFilterParams
  | EdgeguardParams
  | ZeroToDeathsParams
  | AfkDetectionParams
  | KoDirectionParams
  | RemoveStarKOFramesParams
  | DeduplicateParams
  | TrimParams
  | ReverseParams
  | SortParams
  | CustomParams

// ---------------------------------------------------------------------------
// DB Row Types (used by Worker.ts and Archive.ts parseRows)
// ---------------------------------------------------------------------------

export type FilesTableRow = {
  id: number
  path: string
  players: string
  winner: number
  stage: number
  startedAt: number
  lastFrame: number
  isProcessed: number
  info: string
}

export type FilterTableRow = {
  id: number
  JSON: string
}

// ---------------------------------------------------------------------------
// Core Interfaces
// ---------------------------------------------------------------------------

export interface RecentProject {
  name: string
  path: string
  lastOpened: number
}

export interface CustomGeckoCode {
  name: string
  code: string
  enabled: boolean
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
  outputFilenamePattern: string
  defaultProjectDirectory: string
  ffmpegPath: string
  customGeckoCodes: CustomGeckoCode[]
  slpzMode: 'ask' | 'extract' | 'replace'
  slpzOutputDir: string
  slpzPath: string
  detectDuplicatesOnImport: boolean
  includeDefaultFilters: boolean
  savedCustomFilters: SavedCustomFilter[]
  testMode?: boolean
  warnOnParserDelete?: boolean
  advancedMode?: boolean
  fullscreen?: boolean
  widescreen?: boolean
  freezeFD?: boolean
  centerHud?: boolean
  developMode?: boolean
  flashRedLCancel?: boolean
  // Dynamic access escape hatch — used by SettingsModal, SetupWizard, controller
  // TODO: remove once all dynamic config[key] access is refactored
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
  params: Record<string, any>
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
  delete?(dbPath: string): Promise<void>
  generateJSON?(): void
}

export interface ShallowFilterInterface {
  id: string
  type: string
  label: string
  isProcessed: boolean
  params: Record<string, any>
  results: number
  resumable?: boolean
}

export interface CustomParamDef {
  name: string
  type: 'int' | 'string' | 'array'
  value: string
}

export interface OutputFieldDef {
  name: string
  type: 'number' | 'string' | 'boolean' | 'array' | 'object'
}

export interface SavedCustomFilter {
  name: string
  code: string
  customParams?: CustomParamDef[]
  outputFields?: OutputFieldDef[]
  builtIn?: boolean
  category?: string
  description?: string
  requiresParser?: boolean
}

export interface ShallowArchiveInterface {
  path: string
  name: string
  createdAt: number
  files: number
  filters: ShallowFilterInterface[]
  savedCustomFilters?: SavedCustomFilter[]
}

export interface ArchiveInterface {
  path: string
  name: string
  createdAt: number
  files: number
  filters: FilterInterface[]
  savedCustomFilters?: SavedCustomFilter[]
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
      slpzConfig?: {
        slpzBinaryPath: string
        slpzMode: 'extract' | 'replace'
        slpzOutputDir: string
      }
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
  meta?: {
    character1?: string
    character2?: string
    player1?: string
    player2?: string
    stage?: string
    date?: string
    time?: string
    didKill?: boolean
    damage?: number
    moves?: number
  }
}

export type ConsoleWorkerStatus = {
  id: number
  label: string
  progress?: string
  startedAt: number
}

export type ConsoleLogEntry = {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export type ConsoleSnapshot = {
  operation: 'idle' | 'import' | 'filter' | 'recording'
  operationLabel: string
  workers: ConsoleWorkerStatus[]
  aggregate: { current: number; total: number }
}

export type WorkerMessage =
  | WorkerMessageProgress
  | WorkerMessageDone
  | WorkerMessageError
  | WorkerMessageLogs

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

interface WorkerMessageLogs {
  type: 'logs'
  logs: string[]
}
