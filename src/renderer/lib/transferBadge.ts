/**
 * The number on the top bar's Downloads button: transfers that are running or waiting, and
 * those that stopped and need the user (paused, failed, waiting for a project). The panel's own
 * groups agree. Completed and canceled ones are history: counting them left a "1" lit for good
 * after a canceled download.
 */
const OPEN_STAGES = new Set([
  'queued',
  'preparing',
  'downloading',
  'extracting',
  'importing',
  'paused',
  'failed',
  'waiting-project',
])

export const downloadsBadgeCount = (transfers: { stage: string }[]): number =>
  transfers.filter((job) => OPEN_STAGES.has(job.stage)).length
