import fs from 'fs'
import path from 'path'
import os from 'os'
import Archive from '../models/Archive'
import Filter from '../models/Filter'
import { createDB, getMetaData } from './db'
import { filtersConfig } from '../constants/config'
import slpToVideo from './slpToVideo'
import { shuffleArray } from '../lib'
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

export async function runWorkflow(
  config: ConfigInterface,
  options: WorkflowOptions = {},
) {
  const log = options.log || console.log
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

  if (!fs.existsSync(replayDir)) {
    log(`Workflow error: missing replay dir ${replayDir}`)
    return
  }

  const filePaths = fs
    .readdirSync(replayDir)
    .filter((file) => file.endsWith('.slp'))
    .sort()
    .slice(0, sampleCount)
    .map((file) => path.resolve(replayDir, file))

  if (filePaths.length === 0) {
    log(`Workflow error: no .slp files in ${replayDir}`)
    return
  }

  const dbPath =
    process.env.LM_CLIPPER_WORKFLOW_DB ||
    path.resolve(os.tmpdir(), `lm-clipper-workflow-${Date.now()}`)
  const dbName = process.env.LM_CLIPPER_WORKFLOW_NAME || 'workflow-test'

  log(`Workflow: creating archive at ${dbPath}`)
  await createDB(dbPath, dbName)
  const metadata = await getMetaData(dbPath)
  const archive = new Archive(metadata)

  log(`Workflow: importing ${filePaths.length} files`)
  const maxWorkers = Math.max(1, config.numFilterThreads || 1)
  await archive.addFiles(
    filePaths,
    ({ current, total }) => {
      log(`Workflow: import ${current}/${total}`)
    },
    { maxWorkers },
  )

  const filterTemplate = filtersConfig.find((entry) => entry.id === filterType)
  if (!filterTemplate) {
    log(`Workflow error: unknown filter type ${filterType}`)
    return
  }

  const filterId = `filter_${Date.now()}`
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

  log(`Workflow: adding filter ${newFilter.label}`)
  await archive.addFilter(newFilter)

  const filterIndex = archive.filters.findIndex(
    (filter) => filter.id === filterId,
  )
  if (filterIndex < 0) {
    log('Workflow error: filter missing after add')
    return
  }

  log(`Workflow: running filter ${filterId}`)
  const runner = new Filter(archive.filters[filterIndex])
  await runner.run3(
    dbPath,
    'files',
    Math.max(1, config.numFilterThreads || 1),
    ({ current, total }) => {
      log(`Workflow: filter progress ${current}/${total}`)
    },
  )

  archive.filters[filterIndex].isProcessed = true
  archive.filters[filterIndex].results = 0
  await archive.saveMetaData()

  const updatedMeta = await getMetaData(dbPath)
  const updatedFilter = updatedMeta.filters.find(
    (filter) => filter.id === filterId,
  )
  log(`Workflow: filter results ${updatedFilter?.results || 0}`)

  if (skipVideo) {
    log('Workflow: skipping video generation')
    return
  }

  if (!config.outputPath) {
    log('Workflow error: outputPath not set')
    return
  }
  if (!fs.existsSync(config.outputPath)) {
    log(`Workflow error: outputPath does not exist ${config.outputPath}`)
    return
  }
  if (!config.dolphinPath || !config.ssbmIsoPath) {
    log('Workflow error: dolphinPath or ssbmIsoPath not set')
    return
  }

  let outputDirectoryName = 'output'
  let count = 1
  while (fs.existsSync(path.resolve(config.outputPath, outputDirectoryName))) {
    outputDirectoryName = `output_${count}`
    count += 1
  }
  const outputDirectory = path.resolve(config.outputPath, outputDirectoryName)
  fs.mkdirSync(outputDirectory)

  const lastProcessedFilter = updatedMeta.filters
    .slice()
    .reverse()
    .find((filter) => filter.isProcessed && filter.results > 0)
  const resultsTableId = lastProcessedFilter ? lastProcessedFilter.id : 'files'

  let finalResults: (ClipInterface | FileInterface)[] =
    await archive.getAllItems(resultsTableId)
  if (!finalResults || finalResults.length === 0) {
    log('Workflow: no clips to generate')
    return
  }

  if (config.shuffle) finalResults = shuffleArray(finalResults)
  if (config.slice) finalResults = finalResults.slice(0, config.slice)

  const replays: ReplayInterface[] = []
  finalResults.forEach((result, index) => {
    const hasStart =
      typeof result.startFrame === 'number' && result.startFrame !== 0
    const hasEnd = typeof result.endFrame === 'number' && result.endFrame !== 0
    const startFrame = hasStart ? result.startFrame : -123
    const endFrame = hasEnd
      ? result.endFrame
      : (result as FileInterface).lastFrame || 99999

    const adjustedStart = startFrame - config.addStartFrames
    const adjustedEnd = endFrame + config.addEndFrames

    replays.push({
      index,
      path: result.path,
      startFrame: adjustedStart < -123 ? -123 : adjustedStart,
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
  await slpToVideo(replays, videoConfig, (msg: string) => {
    if (msg) log(`Workflow: ${msg}`)
  })
}
