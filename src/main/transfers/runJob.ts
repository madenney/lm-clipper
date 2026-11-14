import fs from 'fs'
import path from 'path'
import { setTimeout as delay } from 'timers/promises'
import {
  databaseExportFilter,
  replayListExportBody,
} from '../../constants/database'
import type { LunarClip } from '../../constants/clipSearch'
import { DownloadLinkExpiredError, downloadBundle } from '../databaseClient'
import {
  extractBundleIntoLibrary,
  extractReplayZip,
  extractReplayFiles,
} from '../replayExtraction'
import {
  FILE_LIST_NAME,
  importSummary,
  notStoredText,
  preparedImportPaths,
  removeUnfinishedAttempts,
} from './files'
import {
  RemoteStatus,
  describeRemoteStatus,
  interpretStatus,
  readyAtOf,
} from './remoteStatus'
import {
  LIST_ONE_BY_ONE_MAX_GAMES,
  fetchDirect,
  fetchStored,
  mergeDirectFiles,
  runDirect,
} from './directRun'
import { runFullDb } from './fullDbRun'
import type { SavedTransfer } from './savedTransfer'
import type { TransferContext } from './context'

export async function runJob(
  ctx: TransferContext,
  job: SavedTransfer,
  signal: AbortSignal,
) {
  if (job.fullDb) {
    await runFullDb(ctx, job, signal)
    return
  }
  // Adding clips whose games are all in the library already: nothing to fetch.
  const listFile = job.clipsFile ?? job.gamesFile
  if (listFile && !job.replayIds?.length && !job.preparedPath)
    ctx.update(job, { preparedPath: listFile })
  // Find replays and Find clips: stored games, from storage only (never the
  // bundle below or the Lunar server at home).
  if (job.kind === 'database' && job.storedOnly && !job.preparedPath) {
    await fetchStored(ctx, job, signal)
    if (!job.preparedPath)
      throw new Error('None of these games could be downloaded.')
  }
  // Other lists (e.g. "Download again" for a project's missing replays): the games
  // in a zip straight from storage by range (runDirect); what's left (newer games,
  // or everything when that can't be used) takes the paths below.
  if (
    job.kind === 'database' &&
    !job.preparedPath &&
    !job.remoteId &&
    !job.direct &&
    ctx.deps.direct?.enabled !== false &&
    (job.filters ||
      (job.replayIds?.length ?? 0) >
        (ctx.deps.directMaxGames ?? LIST_ONE_BY_ONE_MAX_GAMES))
  )
    await runDirect(ctx, job, signal)
  // A small list of games comes one by one from the website's replay route
  // (storage / Cloudflare's cache, else the Lunar server): no export queue, no
  // wait. Bigger leftovers use a server-built bundle.
  if (
    job.kind === 'database' &&
    !job.preparedPath &&
    !job.remoteId &&
    job.replayIds?.length &&
    job.replayIds.length <=
      (ctx.deps.directMaxGames ?? LIST_ONE_BY_ONE_MAX_GAMES)
  )
    await fetchDirect(ctx, job, signal)
  if (job.kind === 'database' && !job.preparedPath) {
    // Never for Find replays or Find clips (fetchStored set preparedPath or threw).
    if (job.storedOnly)
      throw new Error('Stored games only: nothing is packed on the server.')
    if (!job.remoteId) {
      ctx.update(job, {
        stage: 'preparing',
        detail: 'Requesting replay export',
        current: 0,
        total: null,
      })
      // No abort signal: a pause mid-request must not drop the new export's
      // id and grant, or Resume would create a second export.
      const remote = await ctx.client.json<{ jobId: string; token: string }>(
        '/api/clipper?action=create',
        job.replayIds
          ? replayListExportBody(job.replayIds)
          : databaseExportFilter(job.filters!),
      )
      if (
        !/^[a-f0-9]{24}$/.test(remote.jobId) ||
        typeof remote.token !== 'string'
      )
        throw new Error('Invalid database export response.')
      ctx.update(job, { remoteId: remote.jobId, token: remote.token })
      if (signal.aborted) throw new Error('Paused')
    }
    const archive = path.join(job.outputDir, 'download.zip')
    if (!fs.existsSync(archive)) {
      for (;;) {
        const status = await ctx.client.json<RemoteStatus>(
          `/api/clipper?action=status&jobId=${job.remoteId}`,
          undefined,
          job.token,
          signal,
        )
        if (interpretStatus(status) === 'ready') break
        ctx.update(
          job,
          {
            stage: 'preparing',
            detail: describeRemoteStatus(status),
            readyAt: readyAtOf(status),
            current: status.progress?.filesProcessed || 0,
            total: status.progress?.filesTotal || null,
          },
          false,
        )
        await delay(3000, undefined, { signal })
      }
      ctx.update(job, {
        stage: 'downloading',
        readyAt: null,
        detail: 'Downloading replay archive',
        unit: 'bytes',
        current: 0,
        total: null,
      })
      const fetchLink = () =>
        ctx.client.json<{ url: string }>(
          `/api/clipper?action=file&jobId=${job.remoteId}`,
          undefined,
          job.token,
          signal,
        )
      const onBytes = (current: number, total: number | null) =>
        ctx.update(job, { current, total }, false)
      try {
        await downloadBundle((await fetchLink()).url, archive, signal, onBytes)
      } catch (error) {
        // Presigned links last an hour; a resumed transfer may outlive one.
        if (!(error instanceof DownloadLinkExpiredError)) throw error
        await downloadBundle((await fetchLink()).url, archive, signal, onBytes)
      }
    }
    job.sources = [archive]
  }
  if (signal.aborted) throw new Error('Paused')
  if (!job.preparedPath) {
    ctx.update(job, {
      stage: 'extracting',
      detail: 'Extracting and decompressing replays',
      current: 0,
      total: null,
    })
    // The folder this transfer unpacks into is the same one every time, so a
    // pause, a failure or a restart keeps what is already unpacked and Resume
    // carries on (replays already there are skipped): unpacking the whole
    // database takes hours and must not start over. Only Cancel / Remove delete
    // it (discardPartial). Leftover attempts of older builds go.
    const attempt = path.join(job.outputDir, `replays-${job.id.slice(0, 8)}`)
    await removeUnfinishedAttempts(job.outputDir, attempt)
    {
      const onProgress = (
        current: number,
        total: number | null,
        detail: string,
      ) => ctx.update(job, { current, total, detail }, false)
      let detail: string
      let prepared = attempt
      const download = path.join(job.outputDir, 'download.zip')
      const library =
        job.kind === 'database'
          ? await extractBundleIntoLibrary(
              download,
              ctx.deps.getLibrary(),
              ctx.deps.getSlpzBinary(),
              signal,
              onProgress,
            )
          : null
      if (library) {
        prepared = path.join(job.outputDir, FILE_LIST_NAME)
        fs.writeFileSync(prepared, JSON.stringify(library.files))
        // The replays are in the library now; the ZIP would only double the
        // disk use. A retry of the import reads the file list.
        fs.rmSync(download, { force: true })
        detail = `${library.extracted.toLocaleString()} replays added to your library${library.reused ? `, ${library.reused.toLocaleString()} already there` : ''}`
      } else if (job.kind === 'database') {
        // Bundle without a manifest: extract it into this transfer's folder.
        const count = await extractReplayZip(download, attempt, {
          signal,
          onProgress,
          slpzBinary: ctx.deps.getSlpzBinary(),
          keepSlpz: ctx.deps.getLibrary().compress,
          resume: true,
        })
        detail = `${count.toLocaleString()} replay files extracted`
      } else {
        const count = await extractReplayFiles(
          job.sources || [],
          attempt,
          ctx.deps.getSlpzBinary(),
          signal,
          onProgress,
          { resume: true },
        )
        detail = `${count.toLocaleString()} replay files extracted`
      }
      ctx.update(job, {
        preparedPath: prepared,
        detail,
        current: 0,
        total: null,
      })
    }
  }
  if (signal.aborted) throw new Error('Paused')
  mergeDirectFiles(ctx, job)
  if (job.projectPath) {
    if (ctx.deps.getArchive()?.path !== job.projectPath) {
      ctx.update(job, {
        stage: 'waiting-project',
        detail: `Open “${job.projectName}”, then Resume to import.`,
      })
      return
    }
    while (ctx.deps.importer.importInProgress) {
      ctx.update(
        job,
        {
          stage: 'importing',
          detail: 'Waiting for the current import to finish',
          current: 0,
          total: null,
        },
        false,
      )
      await delay(1000, undefined, { signal })
      if (ctx.deps.getArchive()?.path !== job.projectPath) {
        ctx.update(job, {
          stage: 'waiting-project',
          detail: `Open “${job.projectName}”, then Resume to import.`,
        })
        return
      }
    }
    ctx.update(job, {
      stage: 'importing',
      detail: 'Adding replays to project',
      current: 0,
      total: null,
    })
    // Clips: every game the clips come from (some may already be in the
    // library from earlier downloads), not just this download's.
    const clips = job.clipsFile
      ? (JSON.parse(fs.readFileSync(job.clipsFile, 'utf8')) as LunarClip[])
      : null
    // Chosen games likewise: all of them, downloaded now or earlier.
    const wanted = clips
      ? [...new Set(clips.map((c) => c.replayId))]
      : job.gamesFile
        ? (JSON.parse(fs.readFileSync(job.gamesFile, 'utf8')) as string[])
        : null
    const clipPaths = wanted
      ? (await ctx.deps.getLibrary().lookup(wanted, [])).have
      : null
    const result = await ctx.deps.importer.importPrepared(
      clipPaths
        ? Object.values(clipPaths)
        : preparedImportPaths(job.preparedPath!),
      job.projectPath,
      signal,
      (current, total) => ctx.update(job, { current, total }, false),
    )
    let detail = importSummary(result)
    const unreadable = job.unreadable
      ? ` · ${job.unreadable.toLocaleString()} could not be downloaded (skipped)`
      : ''
    if (clips && clipPaths) {
      if (!ctx.deps.addClips) throw new Error('Clips can’t be added here.')
      const { added, unavailable } = await ctx.deps.addClips(
        job.projectPath,
        clips,
        clipPaths,
      )
      detail = `${added.toLocaleString()} clips added${unavailable ? ` · ${unavailable.toLocaleString()} unavailable (${job.storedOnly ? 'game not available yet' : 'game not in the database'})` : ''}`
    } else if (job.notStored) detail += ` · ${notStoredText(job.notStored)}`
    // Done, with a note: damaged replays would fail the same way on a retry, so
    // the transfer does not end "Failed" for them (launch review DL-28); the
    // count of what could not be read stays in the line (DL-10).
    ctx.update(job, {
      result,
      stage: 'completed',
      detail: detail + unreadable,
      error: undefined,
    })
  } else ctx.update(job, { stage: 'completed' })
}
