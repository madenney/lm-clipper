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
  /** Keep games with a CPU (computer) player. Off by default: they're left out. */
  includeCpu?: boolean
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

export type EarlyQuitOutParams = {
  minHits?: string
  maxFiles?: string
  comboTimeout?: string
  // Only emit when the victim was at or above this percent when they quit —
  // the "would this have been a kill?" gate.
  killPercent?: string
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
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
  minOffstageFrames?: string
  rangeLeniency?: string
  includeLedgeSteals?: boolean
  maxLookbackFrames?: string
  maxActionableFrames?: string
  leadInFrames?: string
  // World units inward from each stage's real ledge at which "offstage" begins.
  // Set by the Offstage Line editor; every other stage boundary is derived from
  // Melee's geometry. See DEFAULT_OFFSTAGE_BUFFER in constants/stageGeometry.
  offstageBuffer?: number
}

export type PhantomParams = {
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
  stageFilter?: (string | number)[]
  minDamage?: string
  leadInFrames?: string
  tailFrames?: string
}

export type PhantomFilterParams = {
  // Moves to keep, matched by the attacker's action state (actionStates ids,
  // e.g. Rest). Empty = any move.
  move?: (string | number)[]
  minDamage?: string
  maxDamage?: string
  minHitlag?: string
  minVictimPercent?: string
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
}

export type PressureParams = {
  comboerChar?: (string | number)[]
  comboeeChar?: (string | number)[]
  comboerTag?: string[] | string
  comboerCC?: string[] | string
  comboeeTag?: string[] | string
  comboeeCC?: string[] | string
  stageFilter?: (string | number)[]
  threshold?: string
  minDurationFrames?: string
  smoothingWindow?: string
  maxDipFrames?: string
  closeRange?: string
  shieldWeight?: string
  hitstunWeight?: string
  offenseWeight?: string
  proximityWeight?: string
  openingBonus?: string
  minShieldHits?: string
  requireKill?: boolean
  killBonus?: string
}

export type EdgeguardFilterParams = {
  minHits?: string
  maxHits?: string
  minOffstageFrames?: string
  maxOffstageFrames?: string
  maxLedgeDist?: string
  minDepthX?: string
  maxMinY?: string
  // Discriminative metrics (match Edgeguards Parser's EdgeguardMetrics).
  minRecoveryAttempts?: string
  maxRecoveryAttempts?: string
  minEdgeguarderDepth?: string
  maxEdgeguarderDepth?: string
  minStageTouches?: string
  maxLastHitToDeath?: string
  minScore?: string
  // Tri-state: '' = any, 'yes' = required, 'no' = excluded.
  blockedByHit?: string
  ledgeSteal?: string
  edgeguarderReturned?: string
  diedOffstage?: string
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

export type RandomSampleParams = {
  // Exact number of clips to keep, chosen uniformly at random.
  count?: string
}

export type CustomParams = Record<string, any>

export type FilterParams =
  | FilesFilterParams
  | SlpParserParams
  | EarlyQuitOutParams
  | ComboFilterParams
  | ActionStateFilterParams
  | EdgeguardParams
  | EdgeguardFilterParams
  | PhantomParams
  | PhantomFilterParams
  | PressureParams
  | ZeroToDeathsParams
  | StageCenterParams
  | AfkDetectionParams
  | KoDirectionParams
  | RemoveStarKOFramesParams
  | DeduplicateParams
  | TrimParams
  | ReverseParams
  | SortParams
  | RandomSampleParams
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

// A user-imported custom-texture pack. `path` is a folder of Dolphin hires
// textures (Dolphin scans it recursively, so the internal structure is free).
// Enabled packs are symlinked into the render profile's Load/Textures/GALE01.
export interface TexturePack {
  id: string
  name: string
  path: string
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

/** Recording settings picked for a computer (main/hardware.ts). */
export interface RecordingDefaults {
  numCPUs: number
  resolution: number
  videoPreset: string
  videoQualityMode: 'crf'
  crf: number
  playbackResolution: number
}

/** What Clipper detected about this computer (config.hardwareProfile; not shown). */
export interface HardwareProfile {
  threads: number
  ramGB: number
  gpu: string
  /** Only integrated graphics (Intel / AMD APU) found. */
  integrated: boolean
  /** Free space at the output folder when last checked, GB. */
  freeDiskGB: number | null
  /** Free space where Dolphin's temporary recordings go, GB. */
  scratchFreeDiskGB?: number | null
  detectedAt: string
  /** The settings pickRecordingDefaults chose for it. */
  picked: RecordingDefaults
}

export interface ConfigInterface {
  recentProjects: RecentProject[]
  outputPath: string
  lastArchivePath: string | null
  // "Don't show again" for the long-parser reassurance note.
  hideParserNote?: boolean
  // Once true, the one-time "click Run to find your combos" first-run nudge is
  // never shown again (flipped the first time the user runs or dismisses it).
  hideRunHint?: boolean // first-run Combo Filter auto-run already happened
  // "Don't show this again" on the welcome modal, which otherwise opens the
  // first time a project is open in each session.
  hideWelcome?: boolean
  // The app version whose "What's new" the user has seen (shown once per update;
  // a fresh install starts at its own version, so a new user never sees old notes).
  lastSeenVersion?: string
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
  // Advanced encoding (final re-encode of the lossless FFV1 dump).
  videoCodec?: 'h264' | 'h265' // libx264 (default) or libx265/HEVC
  videoQualityMode?: 'bitrate' | 'crf' // constant-quality (CRF) vs target bitrate
  crf?: number // 0 (lossless) – 51 (worst); ~18 is visually transparent
  videoPreset?: string // x264/x265 preset: ultrafast … veryslow
  keepLosslessMaster?: boolean // keep the FFV1 intermediate .avi next to the output
  // Fast draft: Dolphin dumps lossy mpeg4 with emulation unthrottled instead of
  // lossless FFV1 (3-4x faster, slightly softer). For review copies; off by default.
  fastDraft?: boolean
  // How Dolphin captures: auto = UT Video above 1x (FFV1 at 1x), lossless = FFV1,
  // draft = lossy mpeg4. Replaces fastDraft (read when this is unset).
  recordingFormat?: 'auto' | 'lossless' | 'draft'
  muteRecordings?: boolean // recording Dolphins silent (the dump keeps its audio)
  // Recording Dolphins off screen (runner `hide`: Windows hidden desktop, Linux
  // last workspace; macOS: small background windows only). Default on. Replaces
  // showRecordingDolphin (true there = false here), migrated on load.
  hideRecordingWindows?: boolean
  // Warn before the Replays tray deletes replays (from the project, the replay
  // library and My Replays; files stay on disk). Default on.
  confirmDeleteReplays?: boolean
  // Custom/HD textures. The bundled "Definitive Melee HD" pack is toggled by
  // hdTexturesEnabled; user-imported packs live in texturePacks. Enabled packs
  // are symlinked into the recording/playback Dolphin profile's Load/Textures.
  hdTexturesEnabled?: boolean
  texturePacks?: TexturePack[]
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
  writeManifest: boolean
  autoOpenOutputFolder: boolean
  sendAnonymousUsage: boolean
  // Anonymous-telemetry bookkeeping (internal — not user-facing settings).
  installId?: string // random UUID, generated once on first run
  lastUsagePing?: string // YYYY-MM-DD (UTC) of the last app_open the server acknowledged (daily dedupe)
  lastUsagePingVersion?: string // app version of that app_open: a new version sends one more
  installPingPending?: boolean // the one-time `install` ping has not been acknowledged yet
  consentNoticeSeen?: boolean // first-run usage-stats disclosure dismissed
  // SHA-256 hashes of custom-filter code the user has approved to run (the
  // custom-code consent gate). Running unapproved custom code prompts first.
  approvedCustomCodeHashes?: string[]
  outputFilenamePattern: string
  defaultProjectDirectory: string
  // Replay Library folder for Lunar Database downloads ('' = ~/Documents/Lunar Clipper/Library).
  replayLibraryPath: string
  // Store Lunar Database downloads as .slpz in the library (default on).
  keepDownloadsCompressed?: boolean
  // Lunar Database › Find moments: the note that explains pre-parsed moments (default on; its X turns it off).
  showMomentsNote?: boolean
  // The one-time "tidy up old Untitled projects" offer has been shown.
  untitledCleanupOffered?: boolean
  ffmpegPath: string
  // Where Dolphin's temporary recordings go ('' = the system temp folder).
  scratchPath?: string
  // Detected on first run / Reset / "Pick settings for this computer".
  hardwareProfile?: HardwareProfile | null
  customGeckoCodes: CustomGeckoCode[]
  slpzMode: 'ask' | 'extract' | 'replace' | 'keep'
  slpzOutputDir: string
  slpzPath: string
  includeDefaultFilters: boolean
  savedCustomFilters: SavedCustomFilter[]
  testMode?: boolean
  // Dev only: pin a specific onboarding screen so it renders exclusively while
  // iterating on it. Honored only when testMode is on or in a development build;
  // ignored (and hidden) for normal users. '' / undefined = normal app flow.
  devForceScreen?: string
  // Development builds only: projects the dev bar can open in one click, from
  // this machine's own settings file (never shipped, never in a build).
  devProjects?: { label: string; path: string }[]
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
  /** A CPU (computer) player: Slippi player type 1. Missing on games imported
   *  before Clipper recorded it (cpuScan fills it in); null when the replay
   *  couldn't be read. Unknown counts as a human player. */
  cpu?: boolean | null
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
  // SQLite rowid of this clip within its filter table. Attached at read time by
  // Archive.parseRows (obj.id = row.id); unique per filter table, not globally.
  id?: number
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
    // Set by the Early Quit Out parser: didKill is true because the combo
    // WOULD have killed, but the victim quit out (No Contest) before the stock
    // was actually taken. Distinguishes a denied kill from a real one.
    earlyQuit?: boolean
    moves?: {
      playerIndex: number
      frame: number
      moveId: number
      hitCount: number
      damage: number
    }[]
  }
  recordingParams?: { [key: string]: any }
  // Set on clips added from the Lunar Database (Find clips): the clips index
  // row it came from (constants/clipSearch.ts).
  lunarClip?: { id: string; replayId: string; type: string }
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
    maxDepthX: number
    minY: number
    recoveryAttempts: number
    edgeguarderDepth: number
    edgeguarderReturned: boolean
    lastHitToDeath: number
    stageTouches: number
    diedOffstage: boolean
    score: number
  }
  // Tournament Highlight Finder: composite "reaction" score, its breakdown, and
  // the flavor tags (comeback / clutch / skill / chaos) that fired.
  highlightScore?: number
  highlightMetrics?: HighlightMetrics
  // Phantom hits: damage dealt with ~0 knockback (the victim isn't launched).
  // Score + metrics attached so a downstream Sort can rank by it.
  phantomMetrics?: {
    hitFrame: number
    damage: number
    hitlag: number
    attackerState: number
    attackId: number | null
    victimState: number
    victimPercent: number
  }
  // Pressure: shield-pressure stretch score + metrics (attached so a downstream
  // Sort can rank by it).
  pressureScore?: number
  pressureMetrics?: {
    durationFrames: number
    shieldHits: number
    shieldFrames: number
    scrambleFrames: number
    hitstunFrames: number
    openings: number
    hadOpening: boolean
    peakEval: number
    avgEval: number
    endedInKill: boolean
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
  // A locked step's results are fixed: it never runs and is never reset by a
  // run upstream (lib/filterGraph.ts); the UI shows no Run button.
  locked?: boolean
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
  // See FilterInterface for these.
  inputId?: string
  lastRunMs?: number
  locked?: boolean
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
  // The specific upstream filter type this entry needs (e.g. an Edgeguards
  // Filter needs an 'edgeguard' parser above it). Set on derived native catalog
  // entries so the modal can grey the RIGHT ones; `requiresParser` is the
  // legacy shorthand for "needs the combo parser" used by JS templates.
  requiredProducer?: string
  // When set, this catalog entry adds a native filter of this type instead of
  // a custom JS template (used for frame-data filters that can't be JS code).
  nativeType?: string
}

// A sub-output folder that holds enough finished clips to stitch. `ext` is the
// chosen clip extension for this folder ('.mp4' or '.avi'); `clips` are the
// clip filenames (that extension only, intermediates/`final` excluded), sorted.
export interface StitchFolder {
  path: string
  name: string
  ext: string
  clips: string[]
  // Byte size per clip, keyed by clip filename. Drives the output-size estimate
  // and lets the modal detect on-disk changes (files added/removed/resized).
  sizes: Record<string, number>
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
        slpzMode: 'extract' | 'replace' | 'keep'
        slpzOutputDir: string
        keepInside?: string
      }
      /** models/Archive.ts ImportLibrary (kept loose: types.ts is shared with the renderer). */
      library?: {
        headers: (_files: any[]) => Promise<Record<string, any>>
        record: (_files: any[]) => Promise<unknown>
      }
    },
  ): Promise<{
    terminated: boolean
    failed: number
    /** Failed (broken) files per reason (lib/importSkips.ts FailCounts). */
    failedReasons?: Partial<Record<string, number>>
    inserted: number
    skipped?: number
    /** Skipped files per reason (lib/importSkips.ts SkipCounts). */
    skippedReasons?: Partial<Record<string, number>>
    duplicates?: number
  }>
  getItems?(params: {
    filterId: string
    numPerPage?: number
    currentPage?: number
    offset?: number
    limit?: number
    lite?: boolean
    lane?: string
  }): Promise<(ClipInterface | FileInterface | LiteItem)[]>
  getAllItems?(
    filterId: string,
  ): Promise<(ClipInterface | FileInterface | LiteItem)[]>
  getItemsByIds?(
    filterId: string,
    ids: number[],
  ): Promise<(ClipInterface | FileInterface | LiteItem)[]>
  getSelectionIds?(
    filterId: string,
    selection: import('../lib/selection').SelectionWire,
    limit?: number,
  ): Promise<number[]>
  addFilter?(newFilterJSON: FilterInterface): Promise<void>
  replaceDownstreamFilters?(downstream: FilterInterface[]): Promise<void>
  deleteFilter?(filterId: string): Promise<void>
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
  /** Counts up for the whole session (stable React key, and tells how many were dropped). */
  id: number
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export type ConsoleOperationKind = 'import' | 'filter' | 'recording'

/** One thing running right now. Several can run at once (a recording while a filter runs). */
export type ConsoleOperation = {
  id: number
  kind: ConsoleOperationKind
  label: string
  startedAt: number
  workers: ConsoleWorkerStatus[]
  aggregate: { current: number; total: number }
}

export type ConsoleSnapshot = {
  operations: ConsoleOperation[]
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

// Tournament Highlight Finder score breakdown.
export type HighlightMetrics = {
  score: number
  flavors: string[]
  winProbSwing: number
  comebackMagnitude: number
  killerWinProbAfter: number
  lastStock: boolean
  killerStocks: number
  victimStocksAfter: number
  comboDamage: number
  comboMoves: number
  isZeroToDeath: boolean
  isGimp: boolean
  isSD: boolean
  isTrade: boolean
  disrespect: boolean
  damageRate: number
  victimPercentAtDeath: number
  isSurvival: boolean
  perilPercent: number
  distinctMoves: number
  spikeKill: boolean
  killMove: string
  bothLastStock: boolean
  tensionSecs: number
  reason: string
}
