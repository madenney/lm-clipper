/** @jest-environment node */
import {
  MIN_RECLAIM_BYTES,
  formatBytes,
  planCompaction,
} from '../main/projectCompaction'

const GB = 1e9
const page = 4096
const info = (fileBytes: number, freeBytes: number, autoVacuum = 0) => ({
  pageSize: page,
  pageCount: Math.round(fileBytes / page),
  freePages: Math.round(freeBytes / page),
  autoVacuum,
})

describe('planCompaction', () => {
  it('does nothing when there is little to give back', () => {
    const plan = planCompaction(info(GB, MIN_RECLAIM_BYTES / 2), 100 * GB)
    expect(plan.mode).toBe('none')
  })

  it('rewrites older projects as a copy, needing room for the live data', () => {
    // full_db_only_games.lunar: 7.8 GB file, 6.1 GB empty.
    const plan = planCompaction(info(7.8 * GB, 6.1 * GB), 50 * GB)
    expect(plan.mode).toBe('copy')
    expect(plan.reclaimBytes).toBeCloseTo(6.1 * GB, -6)
    expect(plan.liveBytes).toBeCloseTo(1.7 * GB, -6)
    expect(plan.needBytes).toBeGreaterThan(plan.liveBytes)
    expect(plan.enoughDisk).toBe(true)
  })

  it('refuses a copy without enough free disk', () => {
    const plan = planCompaction(info(57.5 * GB, 11.9 * GB), 20 * GB)
    expect(plan.mode).toBe('copy')
    expect(plan.enoughDisk).toBe(false)
  })

  it('shrinks incremental-vacuum projects in place, with no extra disk', () => {
    const plan = planCompaction(info(10 * GB, 4 * GB, 2), 0)
    expect(plan).toMatchObject({
      mode: 'incremental',
      needBytes: 0,
      enoughDisk: true,
    })
  })
})

describe('formatBytes', () => {
  it('reads like the dialogs', () => {
    expect(formatBytes(57.47 * GB)).toBe('57.5 GB')
    expect(formatBytes(170 * 1e6)).toBe('170 MB')
    expect(formatBytes(40_960)).toBe('41.0 KB')
  })
})
