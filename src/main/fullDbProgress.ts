/**
 * Progress reports for the whole-database download. The file comes straight from
 * storage, so Lunar only learns how far a download got, and whether it finished,
 * from these reports (website /api/clipper?action=full-db-progress, with the
 * downloadId + token the link came with). They are best effort: a failed report
 * never stops or slows the download.
 */

/** Report at least every this many percent of the file... */
export const REPORT_EVERY_FRACTION = 0.05
/** ...or this often, whichever comes first. */
export const REPORT_EVERY_MS = 5 * 60 * 1000

export type SendProgress = (
  _bytesDone: number,
  _done: boolean,
) => Promise<unknown>

export class FullDbProgressReporter {
  private lastBytes = -1

  private lastAt = 0

  private inFlight = false

  private send: SendProgress

  private total: number | null

  private now: () => number

  constructor(
    send: SendProgress,
    total: number | null,
    now: () => number = Date.now,
  ) {
    this.send = send
    this.total = total
    this.now = now
  }

  /** Call on every chunk; sends a report when one is due (never more than one at a time). */
  onBytes(bytes: number, total?: number | null) {
    if (total) this.total = total
    if (this.inFlight || bytes <= this.lastBytes) return
    const step = this.total ? this.total * REPORT_EVERY_FRACTION : Infinity
    const due =
      this.lastBytes < 0 ||
      bytes - this.lastBytes >= step ||
      this.now() - this.lastAt >= REPORT_EVERY_MS
    if (!due) return
    this.lastBytes = bytes
    this.lastAt = this.now()
    this.inFlight = true
    this.send(bytes, false)
      .catch(() => {})
      .finally(() => {
        this.inFlight = false
      })
  }

  /** The whole file is saved and its size checked: say so (a few tries). */
  async finish(bytes: number, retryDelayMs = 2000): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.send(bytes, true)
        return true
      } catch {
        if (attempt < 2)
          await new Promise((resolve) => {
            setTimeout(resolve, retryDelayMs)
          })
      }
    }
    return false
  }
}
