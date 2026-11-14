import fs from 'fs'
import path from 'path'
import os from 'os'
import Archive from '../models/Archive'
import Filter from '../models/Filter'
import {
  createDBAsync as createDB,
  getMetaData,
  getTableCountAsync,
} from './dbAsync'
import { filtersConfig } from '../constants/config'
import slpToVideo from './slpToVideo'
import { createOutputDirectory, getSlpzPath } from './util'
import { extractReplayZip } from './replayExtraction'
import { GAME_START_FRAME } from '../constants/frames'
import { gameEndFrame } from '../lib/lastFrame'
import type {
  ClipInterface,
  ConfigInterface,
  FileInterface,
  FilterInterface,
  ReplayInterface,
} from '../constants/types'

type WorkflowOptions = {
  log?: (_msg: string) => void
}

/** What a run did, for LM_CLIPPER_AUTORUN_REPORT (scripts/win-rig). */
export type WorkflowSummary = {
  ok: boolean
  error?: string
  replayDir?: string
  inputs?: { slp: string[]; slpz: string[]; zip: string[] }
  zips?: { file: string; extracted?: number; ms?: number; error?: string }[]
  slpzBinary?: string
  importMs?: number
  imported?: {
    inserted: number
    failed: number
    skipped: number
    duplicates: number
  }
  projectFiles?: number | null
  filter?: { type: string; results: number; ms: number }
  chain?: {
    type: string
    params: Record<string, unknown>
    results: number
    ms: number
  }[]
  /** The clips recorded, in order (what the chain picked). */
  recorded?: Partial<ClipInterface>[]
  outputDirectory?: string
  clipsQueued?: number
  recordMs?: number
}

type ChainStep = { type: string; params?: Record<string, unknown> }

/** LM_CLIPPER_WORKFLOW_FILTERS (a JSON chain), else the one filter type. */
export function workflowChain(filterType: string): ChainStep[] | null {
  const raw = process.env.LM_CLIPPER_WORKFLOW_FILTERS
  if (!raw) return [{ type: filterType }]
  try {
    const chain = JSON.parse(raw)
    if (
      !Array.isArray(chain) ||
      chain.length === 0 ||
      !chain.every((s) => s && typeof s.type === 'string')
    )
      return null
    return chain
  } catch {
    return null
  }
}

/**
 * LM_CLIPPER_AUTORUN_WORKFLOW: import a folder of replays into a new project,
 * run one filter, record what it found. The folder's .slp files (the first
 * LM_CLIPPER_SAMPLE_COUNT), and every .slpz (decompressed with the bundled
 * slpz, as an import does) and .zip (extracted the way an import does) in it.
 */
export async function runWorkflow(
  config: ConfigInterface,
  options: WorkflowOptions = {},
): Promise<WorkflowSummary> {
  const summary: WorkflowSummary = { ok: false }
  const baseLog = options.log || console.log
  const log = (msg: string) => {
    if (msg.startsWith('Workflow error:')) summary.error = msg
    baseLog(msg)
  }
  const sampleCount = Number.parseInt(
    process.env.LM_CLIPPER_SAMPLE_COUNT || '5',
    10,
  )
  const filterType = process.env.LM_CLIPPER_FILTER_TYPE || 'slpParser'
  const skipVideo = process.env.LM_CLIPPER_SKIP_VIDEO === '1'
  const lowQuality = process.env.LM_CLIPPER_WORKFLOW_LOW_QUALITY === '1'
  const workflowBitrate = Number.parseInt(
    process.env.LM_CLIPPER_WORKFLOW_BITRATE_KBPS || '',
    10,
  )
  const workflowResolution = Number.parseInt(
    process.env.LM_CLIPPER_WORKFLOW_RESOLUTION || '',
    10,
  )
  const workflowNumProcesses = Number.parseInt(
    process.env.LM_CLIPPER_WORKFLOW_NUM_PROCESSES || '',
    10,
  )
  const replayDir =
    process.env.LM_CLIPPER_REPLAY_DIR ||
    path.resolve(process.cwd(), 'test_replays', 'random_lunar_db')

  summary.replayDir = replayDir
  if (!fs.existsSync(replayDir)) {
    log(`Workflow error: missing replay dir ${replayDir}`)
    return summary
  }

  const names = fs.readdirSync(replayDir).sort()
  const ofExt = (ext: string) =>
    names
      .filter((file) => file.toLowerCase().endsWith(ext))
      .map((file) => path.resolve(replayDir, file))
  const slpPaths = ofExt('.slp').slice(0, sampleCount)
  const slpzPaths = ofExt('.slpz')
  const zipPaths = ofExt('.zip')
  summary.inputs = { slp: slpPaths, slpz: slpzPaths, zip: zipPaths }
  // LM_CLIPPER_REPLAY_PATHS: more files or folders (JSON array), imported whole.
  const extraPaths: string[] = process.env.LM_CLIPPER_REPLAY_PATHS
    ? JSON.parse(process.env.LM_CLIPPER_REPLAY_PATHS)
    : []

  // LM_CLIPPER_WORKFLOW_REUSE_TABLE: run the chain on a table of an existing
  // project at LM_CLIPPER_WORKFLOW_DB (no import): re-sorting a finished parse.
  const reuseTable = process.env.LM_CLIPPER_WORKFLOW_REUSE_TABLE || ''
  if (
    !reuseTable &&
    slpPaths.length + slpzPaths.length + zipPaths.length + extraPaths.length ===
      0
  ) {
    log(`Workflow error: no .slp, .slpz or .zip files in ${replayDir}`)
    return summary
  }

  const dbPath =
    process.env.LM_CLIPPER_WORKFLOW_DB ||
    path.resolve(os.tmpdir(), `lm-clipper-workflow-${Date.now()}`)
  const dbName = process.env.LM_CLIPPER_WORKFLOW_NAME || 'workflow-test'

  // ZIPs: extracted next to the project first, as ImportManager does.
  const filePaths: string[] = [...slpPaths, ...slpzPaths, ...extraPaths]
  summary.zips = []
  for (const zip of zipPaths) {
    const dest = path.join(
      `${dbPath}-zips`,
      path.basename(zip, path.extname(zip)),
    )
    const t0 = Date.now()
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const extracted = await extractReplayZip(zip, dest)
      summary.zips.push({ file: zip, extracted, ms: Date.now() - t0 })
      log(`Workflow: extracted ${extracted} from ${path.basename(zip)}`)
      filePaths.push(dest)
    } catch (error) {
      summary.zips.push({ file: zip, error: String(error) })
      log(`Workflow error: extracting ${zip}: ${error}`)
    }
  }

  if (reuseTable && !fs.existsSync(dbPath)) {
    log(`Workflow error: no project to reuse at ${dbPath}`)
    return summary
  }
  if (!reuseTable) {
    log(`Workflow: creating archive at ${dbPath}`)
    await createDB(dbPath, dbName)
  }
  const metadata = await getMetaData(dbPath)
  // A reused project is a copy: its saved metadata still names the original's path.
  const archive = new Archive({ ...metadata, path: dbPath })

  if (!reuseTable) {
    log(`Workflow: importing ${filePaths.length} files`)
    const maxWorkers = Math.max(1, config.numFilterThreads || 1)
    // .slpz: decompressed by the bundled slpz into a folder of their own, or
    // with LM_CLIPPER_WORKFLOW_SLPZ_MODE=keep imported as they are (read in
    // memory; recording decodes a temporary copy, main/slpCache.ts).
    const keep = process.env.LM_CLIPPER_WORKFLOW_SLPZ_MODE === 'keep'
    // LM_CLIPPER_REPLAY_PATHS folders (a library) may hold .slpz too.
    const slpzConfig =
      slpzPaths.length || extraPaths.length
        ? {
            slpzBinaryPath: config.slpzPath || getSlpzPath(),
            slpzMode: keep ? ('keep' as const) : ('extract' as const),
            slpzOutputDir: keep ? '' : `${dbPath}-slpz`,
          }
        : undefined
    if (slpzConfig && !keep) {
      fs.mkdirSync(slpzConfig.slpzOutputDir, { recursive: true })
      summary.slpzBinary = slpzConfig.slpzBinaryPath
    }
    const importStart = Date.now()
    const imported = await archive.addFiles(
      filePaths,
      ({ current, total }) => {
        log(`Workflow: import ${current}/${total}`)
      },
      { maxWorkers, slpzConfig },
    )
    summary.importMs = Date.now() - importStart
    summary.imported = {
      inserted: imported?.inserted ?? 0,
      failed: imported?.failed ?? 0,
      skipped: imported?.skipped ?? 0,
      duplicates: imported?.duplicates ?? 0,
    }
    log(`Workflow: imported ${JSON.stringify(summary.imported)}`)
  }

  // One filter (LM_CLIPPER_FILTER_TYPE, its defaults) or a chain
  // (LM_CLIPPER_WORKFLOW_FILTERS: [{ type, params }], each on the one before).
  const chain = workflowChain(filterType)
  if (!chain) {
    log(`Workflow error: bad filter chain`)
    return summary
  }
  summary.chain = []
  let prevTableId = reuseTable || 'files'
  for (const [step, spec] of chain.entries()) {
    const filterTemplate = filtersConfig.find((entry) => entry.id === spec.type)
    if (!filterTemplate) {
      log(`Workflow error: unknown filter type ${spec.type}`)
      return summary
    }

    const filterId = `filter_${Date.now()}_${step}`
    const newFilter: FilterInterface = {
      id: filterId,
      results: 0,
      type: filterTemplate.id,
      isProcessed: false,
      label: filterTemplate.label,
      params: {},
    }
    filterTemplate.options.forEach((option) => {
      newFilter.params[option.id] = option.default
    })
    Object.assign(newFilter.params, spec.params || {})

    log(`Workflow: adding filter ${newFilter.label}`)
    await archive.addFilter(newFilter)

    const filterIndex = archive.filters.findIndex(
      (filter) => filter.id === filterId,
    )
    if (filterIndex < 0) {
      log('Workflow error: filter missing after add')
      return summary
    }

    log(`Workflow: running filter ${filterId}`)
    const filterStart = Date.now()
    const runner = new Filter(archive.filters[filterIndex])
    await runner.run3(
      dbPath,
      prevTableId,
      Math.max(1, config.numFilterThreads || 1),
      ({ current, total }) => {
        log(`Workflow: filter progress ${current}/${total}`)
      },
    )

    archive.filters[filterIndex].isProcessed = true
    archive.filters[filterIndex].results = await getTableCountAsync(
      dbPath,
      filterId,
    )
    await archive.saveMetaData()
    const results = archive.filters[filterIndex].results || 0
    log(`Workflow: filter results ${results}`)
    summary.chain.push({
      type: spec.type,
      params: newFilter.params,
      results,
      ms: Date.now() - filterStart,
    })
    summary.filter = { type: spec.type, results, ms: Date.now() - filterStart }
    prevTableId = filterId
  }

  const updatedMeta = await getMetaData(dbPath)
  summary.projectFiles =
    (updatedMeta as { files?: number | null }).files ?? null

  if (skipVideo) {
    log('Workflow: skipping video generation')
    summary.ok = !summary.error
    return summary
  }

  if (!config.outputPath) {
    log('Workflow error: outputPath not set')
    return summary
  }
  if (!fs.existsSync(config.outputPath)) {
    log(`Workflow error: outputPath does not exist ${config.outputPath}`)
    return summary
  }
  if (!config.dolphinPath || !config.ssbmIsoPath) {
    log('Workflow error: dolphinPath or ssbmIsoPath not set')
    return summary
  }

  const outputDirectory = createOutputDirectory(config.outputPath)

  const lastProcessedFilter = updatedMeta.filters
    .slice()
    .reverse()
    .find(
      (filter: FilterInterface) =>
        filter.isProcessed && (filter.results ?? 0) > 0,
    )
  // The chain's own last table when it kept something (a reused project's
  // metadata also lists the filters of its earlier runs).
  const chainDone = summary.chain?.[summary.chain.length - 1]
  const resultsTableId =
    chainDone && chainDone.results > 0
      ? prevTableId
      : lastProcessedFilter
        ? lastProcessedFilter.id
        : 'files'

  // getAllItems (non-lite) returns full Clip/File items; the interface's union
  // includes LiteItem for the lite path, which doesn't apply here.
  let finalResults = (await archive.getAllItems(resultsTableId)) as (
    | ClipInterface
    | FileInterface
  )[]
  log(
    `Workflow: results table ${resultsTableId}: ${finalResults?.length ?? 0} items`,
  )
  if (!finalResults || finalResults.length === 0) {
    log('Workflow: no clips to generate')
    summary.ok = !summary.error
    return summary
  }

  if (config.slice) finalResults = finalResults.slice(0, config.slice)
  summary.recorded = finalResults.map((r) => {
    const c = r as ClipInterface
    return {
      path: c.path,
      startFrame: c.startFrame,
      endFrame: c.endFrame,
      stage: c.stage,
      startedAt: c.startedAt,
      comboer: c.comboer,
      comboee: c.comboee,
      combo: c.combo,
    }
  })

  const replays: ReplayInterface[] = []
  finalResults.forEach((result, index) => {
    const hasStart =
      typeof result.startFrame === 'number' && result.startFrame !== 0
    // A game row of an anonymized replay imported before its length was read
    // has endFrame -123 (unknown): that's no end, not an end before the start.
    const hasEnd =
      typeof result.endFrame === 'number' &&
      result.endFrame !== 0 &&
      result.endFrame > GAME_START_FRAME
    const startFrame = hasStart ? result.startFrame : GAME_START_FRAME
    const endFrame = hasEnd
      ? result.endFrame
      : gameEndFrame((result as FileInterface).lastFrame)

    const adjustedStart = startFrame - config.addStartFrames
    const adjustedEnd = endFrame + config.addEndFrames

    replays.push({
      index,
      path: result.path,
      startFrame:
        adjustedStart < GAME_START_FRAME ? GAME_START_FRAME : adjustedStart,
      endFrame: adjustedEnd,
    })
  })

  if (config.lastClipOffset && replays.length > 0) {
    replays[replays.length - 1].endFrame += config.lastClipOffset
  }

  let effectiveBitrate = config.bitrateKbps
  let effectiveResolution = config.resolution
  let effectiveNumCPUs = config.numCPUs

  if (lowQuality) {
    log('Workflow: low quality override enabled')
    if (!effectiveBitrate || effectiveBitrate > 8000) effectiveBitrate = 8000
    if (!effectiveResolution || effectiveResolution > 2) effectiveResolution = 2
    if (!effectiveNumCPUs || effectiveNumCPUs > 1) effectiveNumCPUs = 1
  }

  if (!Number.isNaN(workflowBitrate)) {
    effectiveBitrate = workflowBitrate
  }
  if (!Number.isNaN(workflowResolution)) {
    effectiveResolution = workflowResolution
  }
  if (!Number.isNaN(workflowNumProcesses)) {
    effectiveNumCPUs = workflowNumProcesses
  }

  const videoConfig = {
    ...config,
    outputPath: outputDirectory,
    numProcesses: effectiveNumCPUs || 1,
    dolphinPath: path.resolve(config.dolphinPath),
    ssbmIsoPath: path.resolve(config.ssbmIsoPath),
    gameMusicOn: config.gameMusic,
    disableChants: !config.enableChants,
    bitrateKbps: effectiveBitrate,
    resolution: effectiveResolution,
  }

  log(`Workflow: generating video in ${outputDirectory}`)
  summary.outputDirectory = outputDirectory
  summary.clipsQueued = replays.length
  const recordStart = Date.now()
  // slpToVideo returns a job controller; wait for the recording itself.
  await slpToVideo(replays, videoConfig, (msg: string) => {
    if (msg) log(`Workflow: ${msg}`)
  }).promise
  summary.recordMs = Date.now() - recordStart
  summary.ok = !summary.error
  return summary
}
