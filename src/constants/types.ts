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

// A rectangular position box in Melee world coordinates.
export type StageZoneBox = {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

// Per-player position boxes for a single stage.
export type StageZoneEntry = {
  comboer?: StageZoneBox
  comboee?: StageZoneBox
}

// Position zones keyed by Slippi stage id. Drawn via the Stage Zone picker;
// the Action State filter applies the box matching each clip's stage.
export type PositionZones = Record<number, StageZoneEntry>

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
  // Per-stage position boxes (override the flat scalar X/Y fields above).
  positionZones?: PositionZones
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

export type Edgeguard2Params = {
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
  stageFilter?: (string | number)[]
  minOffstageFrames?: string
  rangeLeniency?: string
  requireEdgeguarderCommit?: boolean
  includeLedgeSteals?: boolean
  maxLookbackFrames?: string
}

export type EdgeguardFilterParams = {
  minHits?: string
  maxHits?: string
  minOffstageFrames?: string
  maxOffstageFrames?: string
  maxLedgeDist?: string
  minDepthX?: string
  maxMinY?: string
  minScore?: string
  // Tri-state: '' = any, 'yes' = required, 'no' = excluded.
  blockedByHit?: string
  ledgeSteal?: string
  edgeguarderOffstage?: string
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
}

export type StageCenterParams = {
  maxDistance: string
  useComboer?: boolean
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
  | Edgeguard2Params
  | EdgeguardFilterParams
  | ZeroToDeathsParams
  | StageCenterParams
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

export type OverlayPosition =
  | 'bottom-left'
  | 'bottom-right'
  | 'top-left'
  | 'top-right'

/**
 * A rule for deriving the {source} overlay token from a clip's file path.
 * Rules are evaluated in order; the first whose `marker` is found in the path
 * wins. The extracted value is prefixed with `prefix` to form the final string.
 */
export interface OverlaySourceRule {
  id: string
  // Path must contain this segment for the rule to match. Empty = always match
  // (use as a catch-all fallback at the end of the list).
  marker: string
  // How to derive the value once matched:
  //  - nextSegment: the path segment immediately after `marker`
  //  - fixed:       the literal text in `value`
  //  - regex:       first capture group of `value` (a regex) tested against the path
  extract: 'nextSegment' | 'fixed' | 'regex'
  value: string
  // Wrap the extracted value: prefix + value + suffix.
  // e.g. prefix "" + value "DaShizWiz" + suffix " netplay" => "DaShizWiz netplay"
  prefix: string
  suffix: string
}

export interface ConfigInterface {
  recentProjects: RecentProject[]
  outputPath: string
  lastArchivePath: string | null
  // Show the "Getting started" column on the Start screen (and lets the
  // Help → Welcome content be dismissed). Default-on (treated as true when
  // undefined); toggled off via the Start screen's checkbox.
  showGettingStarted?: boolean
  // "Don't show again" for the long-parser reassurance note.
  hideParserNote?: boolean
  // Once true, the one-time "click Run to find your combos" first-run nudge is
  // never shown again (flipped the first time the user runs or dismisses it).
  hideRunHint?: boolean
  hideHud: boolean
  gameMusic: boolean
  enableChants: boolean
  disableScreenShake: boolean
  hideTags: boolean
  hideNames: boolean
  overlayEnabled: boolean
  overlayPattern: string
  overlayPosition: OverlayPosition
  overlaySourceRules: OverlaySourceRule[]
  fixedCamera: boolean
  noElectricSFX: boolean
  noCrowdNoise: boolean
  disableMagnifyingGlass: boolean
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
  autoOpenOutputFolder: boolean
  sendAnonymousUsage: boolean
  // Anonymous-telemetry bookkeeping (internal — not user-facing settings).
  installId?: string // random UUID, generated once on first run
  lastUsagePing?: string // YYYY-MM-DD of the last app_open ping (daily dedupe)
  consentNoticeSeen?: boolean // first-run usage-stats disclosure dismissed
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
  // Advanced: lets a filter read from any earlier filter (or raw Files) instead
  // of just the one above it, turning the chain into a tree. Default off; when
  // off, saved branch links are preserved but ignored (chain runs linearly).
  branchingEnabled?: boolean
  warnOnParserDelete?: boolean
  // Long-run reset warnings come in three independent severity tiers by last-run
  // duration (≥60s, ≥10m, ≥1h). Each flag, when false, silences just that tier's
  // "are you sure?" prompt. Set via each modal's "Don't warn me again" checkbox.
  warnOnReset60s?: boolean
  warnOnReset10m?: boolean
  warnOnReset1h?: boolean
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
  // Edgeguard 2: heuristic interestingness score + metrics for the offstage
  // sequence (attached so a downstream Sort can rank by it).
  edgeguardScore?: number
  edgeguardMetrics?: {
    offstageFrames: number
    hits: number
    recoveryFrame: number | null
    minLedgeDist: number
    blockedByHit: boolean
    ledgeSteal: boolean
    edgeguarderOffstage: boolean
    maxDepthX: number
    minY: number
    score: number
  }
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
  // null = count not yet known (hydrated lazily after open; UI shows a spinner)
  results: number | null
  resumable?: boolean
  resumeProgress?: { processed: number; totalInput: number }
  // Branching: id of the filter (or 'files') this filter reads from. Unset =
  // reads from the filter directly above it in the list (legacy linear chain).
  inputId?: string
  // Wall-clock ms the last successful run took. Drives the long-run reset
  // warning so we don't silently nuke an expensive (e.g. 15-hour) run.
  lastRunMs?: number
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
  // null = count not yet known (hydrated lazily after open; UI shows a spinner)
  results: number | null
  resumable?: boolean
  resumeProgress?: { processed: number; totalInput: number }
  // See FilterInterface for these two.
  inputId?: string
  lastRunMs?: number
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
  // When set, this catalog entry adds a native filter of this type instead of
  // a custom JS template (used for frame-data filters that can't be JS code).
  nativeType?: string
}

export interface ShallowArchiveInterface {
  path: string
  name: string
  createdAt: number
  // null = file count not yet known (hydrated lazily after open)
  files: number | null
  filters: ShallowFilterInterface[]
  savedCustomFilters?: SavedCustomFilter[]
}

export interface ArchiveInterface {
  path: string
  name: string
  createdAt: number
  files: number | null
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
  resetFiltersFrom?(
    startIndex: number,
    branchingEnabled?: boolean,
  ): Promise<void>
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
  skipped?: number
}

interface WorkerMessageDone {
  type: 'done'
  results: number
  missing?: number
  corrupt?: number
  examples?: string[]
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
