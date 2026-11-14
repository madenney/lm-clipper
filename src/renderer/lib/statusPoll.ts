/**
 * How often the Lunar Database panel asks the website for its status (the admin notice, whether
 * it is up, the queue). Only while the panel is open or a download is running: a Clipper left
 * open all day must not ask the server every 30 seconds for nothing. After failures it backs
 * off (an offline PC, a server having a bad hour) instead of hammering.
 */
export const STATUS_POLL_MS = 30_000
export const STATUS_POLL_MAINTENANCE_MS = 15_000
const STATUS_POLL_MAX_MS = 300_000

export function statusPollDelay(
  failures: number,
  maintenance: boolean,
): number {
  if (failures > 0)
    return Math.min(
      STATUS_POLL_MAX_MS,
      STATUS_POLL_MS * 2 ** Math.min(failures, 4),
    )
  return maintenance ? STATUS_POLL_MAINTENANCE_MS : STATUS_POLL_MS
}
