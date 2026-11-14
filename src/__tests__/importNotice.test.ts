/**
 * @jest-environment node
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { importResultNotice } from '../renderer/importNotice'
import { fileProcessor } from '../models/File'
import {
  describeFailures,
  describeSkips,
  invalidReasonFor,
} from '../lib/importSkips'

describe('importResultNotice', () => {
  it('stays quiet when everything was added, cancelled, or counts are missing', () => {
    expect(importResultNotice({ inserted: 3 })).toBeNull()
    expect(importResultNotice({ inserted: 3, duplicates: 2 })).toBeNull()
    expect(importResultNotice({ inserted: 0, cancelled: true })).toBeNull()
    expect(importResultNotice({})).toBeNull()
  })

  it('says nothing was found when the drop held no replays', () => {
    expect(
      importResultNotice({ inserted: 0, skipped: 0, duplicates: 0, failed: 0 }),
    ).toMatch(/No Slippi replays/)
  })

  it('explains duplicates and unreadable files', () => {
    expect(importResultNotice({ inserted: 0, duplicates: 1 })).toMatch(
      /That replay is already/,
    )
    expect(importResultNotice({ inserted: 0, duplicates: 12 })).toMatch(
      /Those 12 replays are already/,
    )
    expect(importResultNotice({ inserted: 0, failed: 2 })).toBe(
      'Nothing added. 2 files could not be read as Slippi replays.',
    )
    expect(importResultNotice({ inserted: 0, duplicates: 2, failed: 1 })).toBe(
      'Nothing added. 2 replays already in this project. 1 file could not be read as Slippi replays.',
    )
  })

  it('gives skipped .slpz files their own wording, not "could not be read"', () => {
    const message = importResultNotice({
      inserted: 0,
      skipped: 4,
      skippedReasons: { slpz: 4 },
    })
    expect(message).toBe(
      'Nothing added. Skipped 4 .slpz files (not decompressed).',
    )
    expect(message).not.toMatch(/could not be read/)
  })

  it('says how many games were left out and why, also when others were added', () => {
    expect(
      importResultNotice({
        inserted: 196,
        skipped: 4,
        skippedReasons: { not1v1: 4 },
      }),
    ).toBe(
      'Added 196 games. 4 games skipped: not 1v1, e.g. teams or 4-player free-for-all (Clipper imports 1v1 games only).',
    )
    expect(
      importResultNotice({
        inserted: 1,
        skipped: 3,
        skippedReasons: { short: 1, slpz: 2 },
        failed: 1,
      }),
    ).toBe(
      'Added 1 game. 1 game skipped: shorter than 20 seconds. Skipped 2 .slpz files (not decompressed). 1 file could not be read as Slippi replays.',
    )
  })

  it('still says something for skips without reasons (older main)', () => {
    expect(importResultNotice({ inserted: 0, skipped: 2 })).toBe(
      'Nothing added. 2 files skipped.',
    )
  })
})

describe('broken files count as failed, with a reason', () => {
  it('says why each broken file failed', () => {
    expect(
      importResultNotice({
        inserted: 0,
        failed: 3,
        failedReasons: { unreadable: 1, incomplete: 2 },
      }),
    ).toBe(
      'Nothing added. 1 file could not be read as Slippi replays. 2 files could not be read: damaged or cut off before the game ended.',
    )
  })

  it('keeps skipped and failed apart when both happen', () => {
    const message = importResultNotice({
      inserted: 10,
      skipped: 2,
      skippedReasons: { not1v1: 2 },
      failed: 1,
      failedReasons: { incomplete: 1 },
    })
    expect(message).toBe(
      'Added 10 games. 2 games skipped: not 1v1, e.g. teams or 4-player free-for-all (Clipper imports 1v1 games only). 1 file could not be read: damaged or cut off before the game ended.',
    )
  })
})

describe('import reasons', () => {
  it('maps models/File.ts reasons: intentional skips vs broken files', () => {
    const skipped = (reason: string) => ({ kind: 'skipped', reason })
    const failed = (reason: string) => ({ kind: 'failed', reason })
    expect(invalidReasonFor('teams')).toEqual(skipped('not1v1'))
    expect(invalidReasonFor('!2 players')).toEqual(skipped('not1v1'))
    expect(invalidReasonFor('Game Length < 20 seconds')).toEqual(
      skipped('short'),
    )
    expect(invalidReasonFor('Invalid stage')).toEqual(skipped('noStage'))
    expect(invalidReasonFor('Bad settings')).toEqual(failed('unreadable'))
    expect(invalidReasonFor('Bad metadata')).toEqual(failed('incomplete'))
    expect(invalidReasonFor('No lastFrame in metadata')).toEqual(
      failed('incomplete'),
    )
    expect(invalidReasonFor('No length')).toEqual(failed('incomplete'))
    expect(invalidReasonFor(undefined)).toEqual(failed('incomplete'))
  })

  it('real broken files come out failed, a good one valid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-'))
    const whole = fs.readFileSync(
      path.resolve(__dirname, '../../assets/test.slp'),
    )
    const write = (name: string, bytes: Buffer) => {
      const p = path.join(dir, name)
      fs.writeFileSync(p, bytes)
      return p
    }
    const reason = (p: string) => {
      const file = fileProcessor(p)
      return file.isValid ? 'valid' : invalidReasonFor(file.info)
    }
    try {
      expect(
        reason(write('junk.slp', Buffer.from('not a replay at all'))),
      ).toEqual({ kind: 'failed', reason: 'unreadable' })
      expect(reason(write('empty.slp', Buffer.alloc(0)))).toEqual({
        kind: 'failed',
        reason: 'unreadable',
      })
      // Cut off mid-game: settings read, the end (metadata) is gone.
      expect(reason(write('cut.slp', whole.subarray(0, 40000)))).toEqual({
        kind: 'failed',
        reason: 'incomplete',
      })
      expect(reason(write('good.slp', whole))).toBe('valid')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('describes no failures when none failed', () => {
    expect(describeFailures(undefined)).toEqual([])
    expect(describeFailures({})).toEqual([])
  })

  it('describes nothing when nothing was skipped', () => {
    expect(describeSkips(undefined)).toEqual([])
    expect(describeSkips({})).toEqual([])
    expect(describeSkips({ slpz: 1 })).toEqual([
      'Skipped 1 .slpz file (not decompressed)',
    ])
  })
})
