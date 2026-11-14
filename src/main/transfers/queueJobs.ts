import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import {
  DatabaseFilters,
  parseFullDbInfo,
  FULL_DB_FILE_NAME,
} from '../../constants/database'
import type { LunarClip } from '../../constants/clipSearch'
import { shownProjectName } from '../../constants/defaultProject'
import { askDialog } from '../askRenderer'
import { defaultReplaysFolder } from '../dataLocations'
import { formatBytes } from '../../lib/format'
import { isInside, realPath } from './files'
import type { SavedTransfer } from './savedTransfer'
import type { TransferContext } from './context'

/** " to “Name”" for a named project, nothing for the default one. */
const toProject = (name: string | undefined) => {
  const shown = shownProjectName(name)
  return shown ? ` to “${shown}”` : ''
}

/**
 * Find clips › Add to project: download the games the library doesn't have
 * yet, import the clips' games into the project (My Replays if none is open)
 * and add the clips as its "Lunar Database clips" result (deps.addClips).
 */
export async function addClips(ctx: TransferContext, clips: LunarClip[]) {
  if (!ctx.deps.getArchive()) await ctx.deps.ensureProject()
  const archive = ctx.deps.getArchive()
  if (!archive) throw new Error('Open or create a project first.')
  const ids = [...new Set(clips.map((c) => c.replayId))]
  const { missing } = await ctx.deps.getLibrary().lookup(ids, [])
  const id = randomUUID()
  const outputDir = path.join(
    ctx.deps.getLibrary().folder,
    'Downloads',
    `Lunar-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`,
  )
  fs.mkdirSync(outputDir, { recursive: true })
  const clipsFile = path.join(outputDir, 'clips.json')
  fs.writeFileSync(clipsFile, JSON.stringify(clips))
  const n = clips.length.toLocaleString()
  ctx.jobs.unshift({
    id,
    kind: 'database',
    title: `Add ${n} ${clips.length === 1 ? 'clip' : 'clips'}${toProject(archive.name)}`,
    createdAt: Date.now(),
    stage: 'queued',
    detail: missing.length
      ? `${missing.length.toLocaleString()} games to download`
      : 'All games already downloaded',
    outputDir,
    projectPath: archive.path,
    projectName: archive.name,
    current: 0,
    total: null,
    ...(missing.length ? { replayIds: missing } : {}),
    clipsFile,
    // Find clips: the games come from storage only.
    storedOnly: true,
  })
  ctx.save()
}

/**
 * Find replays › Add selected: download the chosen games the library doesn't
 * have yet, then import all of them into the project (My Replays if none is
 * open).
 */
export async function addReplays(ctx: TransferContext, replayIds: string[]) {
  if (!ctx.deps.getArchive()) await ctx.deps.ensureProject()
  const archive = ctx.deps.getArchive()
  if (!archive) throw new Error('Open or create a project first.')
  const ids = [...new Set(replayIds)]
  const { missing } = await ctx.deps.getLibrary().lookup(ids, [])
  const id = randomUUID()
  const outputDir = path.join(
    ctx.deps.getLibrary().folder,
    'Downloads',
    `Lunar-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`,
  )
  fs.mkdirSync(outputDir, { recursive: true })
  const gamesFile = path.join(outputDir, 'games.json')
  fs.writeFileSync(gamesFile, JSON.stringify(ids))
  const n = ids.length.toLocaleString()
  ctx.jobs.unshift({
    id,
    kind: 'database',
    title: `Add ${n} ${ids.length === 1 ? 'game' : 'games'}${toProject(archive.name)}`,
    createdAt: Date.now(),
    stage: 'queued',
    detail: missing.length
      ? `${missing.length.toLocaleString()} to download, ${(ids.length - missing.length).toLocaleString()} already in your library`
      : 'All already in your library',
    outputDir,
    projectPath: archive.path,
    projectName: archive.name,
    current: 0,
    total: null,
    ...(missing.length ? { replayIds: missing } : {}),
    gamesFile,
    // Find replays: the games come from storage only.
    storedOnly: true,
  })
  ctx.save()
}

/** The whole database: one big file into Downloads, queued at once. */
export async function queueFullDb(ctx: TransferContext) {
  const info = parseFullDbInfo(
    await ctx.client.json('/api/download?action=bundles&limit=50'),
  )
  if (!info)
    throw new Error('The full database file is not available right now.')
  const existing = ctx.jobs.find(
    (j) => j.fullDb && !['completed', 'canceled'].includes(j.stage),
  )
  if (existing) throw new Error('The full database is already downloading.')
  // Straight into the Downloads folder: no questions, it just starts.
  let file = path.join(app.getPath('downloads'), FULL_DB_FILE_NAME)
  if (fs.existsSync(file)) {
    // The same size is the same snapshot (they are made whole, never edited): you
    // have it. A different size is an older snapshot, or something else with that
    // name: the new one goes beside it, dated, and the old one is left alone
    // (launch review DL-25).
    if (fs.statSync(file).size === info.bytes)
      throw new Error(`You already have it: ${file}`)
    const ext = path.extname(FULL_DB_FILE_NAME)
    const stem = path.basename(FULL_DB_FILE_NAME, ext)
    const day = new Date().toISOString().slice(0, 10)
    for (let n = 0; ; n++) {
      file = path.join(
        app.getPath('downloads'),
        `${stem}-${day}${n ? `-${n + 1}` : ''}${ext}`,
      )
      if (!fs.existsSync(file)) break
    }
  }
  // statfs is in Electron's Node (18.15+), not in this project's Node types.
  const statfs = (
    fs.promises as unknown as {
      statfs?: (_path: string) => Promise<{ bavail: number; bsize: number }>
    }
  ).statfs
  const free = statfs
    ? await statfs(path.dirname(file))
        .then((st) => st.bavail * st.bsize)
        .catch(() => null)
    : null
  if (free !== null && free < info.bytes) {
    const { response } = await askDialog(ctx.window, {
      type: 'warning',
      title: 'Not enough space',
      message: `That drive has ${formatBytes(free)} free; the file is ${formatBytes(info.bytes)}.`,
      detail:
        'Choose a bigger drive, or start anyway and free up space before it fills.',
      buttons: ['Start anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    if (response !== 0) return
  }
  const id = randomUUID()
  ctx.jobs.unshift({
    id,
    kind: 'database',
    fullDb: true,
    file,
    title: 'The whole Lunar Database',
    createdAt: Date.now(),
    stage: 'queued',
    detail: `${formatBytes(info.bytes)}${info.replays ? ` · ${info.replays.toLocaleString()} games` : ''} · saved as one file`,
    outputDir: path.dirname(file),
    current: 0,
    total: info.bytes,
    unit: 'bytes',
  })
  ctx.save()
}

/** Unpack a downloaded file (the whole database) with Extract Replays. */
export async function unpackFile(ctx: TransferContext, id: string) {
  const job = ctx.jobs.find((j) => j.id === id)
  if (!job?.file || !fs.existsSync(job.file))
    throw new Error('That file is not there any more.')
  const size = fs.statSync(job.file).size
  const destination = defaultReplaysFolder()
  const { response } = await askDialog(ctx.window, {
    type: 'question',
    title: 'Unpack replays',
    message: `Unpack ${path.basename(job.file)}?`,
    detail: `Every game is unpacked to a playable .slp in ${destination}. Unpacked replays take about 8 times the space: roughly ${formatBytes(size * 8)} for this file. It takes hours; you can pause it. The ZIP is kept.`,
    buttons: ['Unpack', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return
  await queueJob(ctx, {
    kind: 'extract',
    sources: [job.file],
    importAfter: false,
  })
}

/** Create a filter download or a local extraction and save it (queued). */
export async function queueJob(
  ctx: TransferContext,
  spec:
    | { kind: 'database'; filters: DatabaseFilters }
    | {
        kind: 'extract'
        sources: string[]
        outputDir?: string
        importAfter: boolean
      },
) {
  // Database batches download into the library (the ZIP is removed once
  // its replays are in); extractions go where the user chose.
  const root =
    spec.kind === 'database'
      ? path.join(ctx.deps.getLibrary().folder, 'Downloads')
      : spec.outputDir || defaultReplaysFolder()
  if (!path.isAbsolute(root))
    throw new Error('Choose an absolute destination folder.')
  const sources = spec.kind === 'extract' ? spec.sources : undefined
  for (const source of sources || []) {
    if (isInside(realPath(root), realPath(source)))
      throw new Error(
        'Choose an output folder outside the selected source folder.',
      )
  }
  const needsProject = spec.kind === 'database' || spec.importAfter
  if (needsProject && !ctx.deps.getArchive()) await ctx.deps.ensureProject()
  const archive = needsProject ? ctx.deps.getArchive() : null
  if (needsProject && !archive)
    throw new Error('Open or create a project first.')
  const id = randomUUID()
  const outputDir = path.join(
    root,
    `Lunar-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`,
  )
  fs.mkdirSync(outputDir, { recursive: true })
  const job: SavedTransfer = {
    id,
    kind: spec.kind,
    title:
      spec.kind === 'database'
        ? `Up to ${spec.filters.maxFiles.toLocaleString()} Lunar replays`
        : 'Extract replay files',
    createdAt: Date.now(),
    stage: 'queued',
    detail: 'Waiting to start',
    outputDir,
    projectPath: archive?.path,
    projectName: archive?.name,
    current: 0,
    total: null,
    sources,
    filters: spec.kind === 'database' ? spec.filters : undefined,
    // Find replays: only stored games, from storage only.
    ...(spec.kind === 'database' ? { storedOnly: true } : {}),
  }
  ctx.jobs.unshift(job)
  ctx.save()
}
