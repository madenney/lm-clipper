import fs from 'fs'
import path from 'path'
import { setTimeout as delay } from 'timers/promises'
import { DownloadLinkExpiredError, downloadBundle } from '../databaseClient'
import { FullDbProgressReporter } from '../fullDbProgress'
import { formatBytes } from '../../lib/format'
import { RetryLaterError } from './errors'
import type { SavedTransfer } from './savedTransfer'
import type { TransferContext } from './context'

/** Storage refusing the link this many times in a row with no new bytes ends the run. */
const MAX_REFUSED_LINKS = 4

/** The whole database: one file straight from storage, resumable. */
export async function runFullDb(
  ctx: TransferContext,
  job: SavedTransfer,
  signal: AbortSignal,
) {
  const file = job.file!
  ctx.update(job, {
    stage: 'downloading',
    detail: `Downloading to ${file}`,
    unit: 'bytes',
  })
  // Lunar logs each whole-database download and whether it finished. The link
  // comes with a downloadId + token (kept on the transfer, so a resume after a
  // pause or restart keeps the same record); asking again with them doesn't use
  // up one of the day's full-database links.
  const fetchLink = async () => {
    const link = await ctx.client.json<{
      url: string
      downloadId?: string
      token?: string
    }>('/api/clipper?action=full-db', undefined, undefined, signal, {
      ...(job.fullDbDownloadId && job.fullDbToken
        ? {
            'X-Full-Db-Download': `${job.fullDbDownloadId}.${job.fullDbToken}`,
          }
        : {}),
    })
    if (
      typeof link.downloadId === 'string' &&
      /^[a-f0-9]{24}$/.test(link.downloadId) &&
      (typeof link.token === 'string' ||
        link.downloadId === job.fullDbDownloadId)
    ) {
      const fresh = link.downloadId !== job.fullDbDownloadId
      job.fullDbDownloadId = link.downloadId
      if (typeof link.token === 'string') job.fullDbToken = link.token
      if (fresh) ctx.save()
    }
    return link
  }
  const sendProgress = (bytesDone: number, done: boolean) =>
    job.fullDbDownloadId && job.fullDbToken
      ? ctx.client.json('/api/clipper?action=full-db-progress', {
          downloadId: job.fullDbDownloadId,
          token: job.fullDbToken,
          bytesDone,
          done,
        })
      : Promise.resolve()
  const reporter = new FullDbProgressReporter(sendProgress, job.total)
  const onBytes = (current: number, total: number | null) => {
    ctx.update(job, { current, total: total ?? job.total }, false)
    reporter.onBytes(current, total)
  }
  // Links last an hour; a download this big outlives many of them. A link that
  // storage keeps refusing without a single new byte (object gone, wrong host,
  // a rule in front of it) is not a renewal: wait a little, then stop after a
  // few tries instead of hammering the website (launch review DL-14).
  let refused = 0
  let bytesSeen = -1
  const progress = (current: number, total: number | null) => {
    if (current !== bytesSeen) refused = 0
    bytesSeen = current
    onBytes(current, total)
  }
  for (;;) {
    try {
      await downloadBundle((await fetchLink()).url, file, signal, progress)
      break
    } catch (error) {
      if (!(error instanceof DownloadLinkExpiredError)) throw error
      refused += 1
      if (refused >= MAX_REFUSED_LINKS)
        throw new RetryLaterError(
          "Lunar's storage is not accepting the download link right now. Try again later: what is downloaded so far is kept.",
        )
      await delay(Math.min(2 ** refused, 15) * 1000, undefined, { signal })
    }
  }
  // downloadBundle checked the size before renaming: the whole file is here.
  await reporter.finish(fs.statSync(file).size)
  ctx.update(job, {
    stage: 'completed',
    detail: `Saved ${path.basename(file)} (${formatBytes(fs.statSync(file).size)}). Unpack it to play the games.`,
    current: 0,
  })
}
