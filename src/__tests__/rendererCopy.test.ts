/**
 * The renderer's small pure rules from the launch review's UX findings: what failures say, when
 * per-clip actions are blocked, what an empty step says, how the update banner talks, how often
 * the status poll asks, free space, number boxes, compressed ISOs, the downloads badge, the grid's
 * keyboard moves. No React here.
 */
import { openFailureNotice } from '../renderer/lib/openNotice'
import { clipActionBlock } from '../renderer/lib/clipActions'
import { emptyResultsCopy } from '../renderer/lib/emptyResults'
import {
  updateErrorDetails,
  updateErrorText,
} from '../renderer/lib/updateStatus'
import {
  STATUS_POLL_MS,
  STATUS_POLL_MAINTENANCE_MS,
  statusPollDelay,
} from '../renderer/lib/statusPoll'
import { freeSpaceNote } from '../renderer/lib/freeSpace'
import {
  damageValid,
  hitsValid,
  limitsProblem,
  normalizeDecimalInput,
} from '../renderer/lib/limitInput'
import {
  compressedImageKind,
  compressedImageMessage,
} from '../renderer/lib/isoImage'
import { downloadsBadgeCount } from '../renderer/lib/transferBadge'
import { gridKeyTarget, scrollToShow } from '../renderer/lib/gridKeys'
import { describeWork, noWork } from '../renderer/hooks/useWorkRunning'
import { commitInt, cleanPath } from '../renderer/components/SettingsFields'

jest.mock('../renderer/ipcBridge', () => ({ __esModule: true, default: {} }))

describe('openFailureNotice', () => {
  it('says nothing for a cancelled dialog or a success', () => {
    expect(openFailureNotice('import', null)).toBeNull()
    expect(openFailureNotice('import', undefined)).toBeNull()
    expect(openFailureNotice('open', { path: '/p.lunar', filters: [] })).toBe(
      null,
    )
  })

  it("turns main's developer strings into plain sentences", () => {
    expect(
      openFailureNotice('import', { error: 'Failed to create project' }),
    ).toMatch(/free space.*Documents folder/)
    expect(openFailureNotice('import', { error: 'archive undefined' })).toMatch(
      /New Project/,
    )
    expect(
      openFailureNotice('open', { error: 'Project file not found' }),
    ).toMatch(/Recent list/)
    expect(
      openFailureNotice('open', {
        error: 'Request timed out (openRecentProject)',
      }),
    ).toMatch(/too long/)
  })

  it('names what failed, with the reason when there is one', () => {
    expect(openFailureNotice('new', { error: 'EACCES: denied' })).toBe(
      "Couldn't create the project: EACCES: denied",
    )
    expect(
      openFailureNotice('open', { error: true, info: new Error('bad row') }),
    ).toBe("Couldn't open that project: bad row")
    expect(openFailureNotice('saveAs', { error: true })).toMatch(
      /save the project there\. See the console/,
    )
  })
})

describe('clipActionBlock', () => {
  it('lets a clip play or record when nothing runs', () => {
    const idle = { isGenerating: false, isPlaying: false }
    expect(clipActionBlock(idle, 'play')).toBeNull()
    expect(clipActionBlock(idle, 'record')).toBeNull()
  })

  it('blocks a second Dolphin on top of a recording or a preview', () => {
    expect(
      clipActionBlock({ isGenerating: true, isPlaying: false }, 'record'),
    ).toMatch(/recording is already running/)
    expect(
      clipActionBlock({ isGenerating: true, isPlaying: false }, 'play'),
    ).toMatch(/recording is running/)
    expect(
      clipActionBlock({ isGenerating: false, isPlaying: true }, 'record'),
    ).toMatch(/playing in Dolphin/)
    expect(
      clipActionBlock({ isGenerating: false, isPlaying: true }, 'play'),
    ).toMatch(/already playing/)
  })
})

describe('emptyResultsCopy', () => {
  const base = { running: false, readError: false, processed: false }

  it('a step that has not run yet says to run it', () => {
    expect(emptyResultsCopy(base)).toEqual({
      title: 'No clips to display',
      subtitle: 'Run this filter to see results',
    })
  })

  it('a step that ran and found nothing says so and what to loosen', () => {
    const combos = emptyResultsCopy({
      ...base,
      processed: true,
      type: 'comboFilter',
    })
    expect(combos.title).toBe('No combos found')
    expect(combos.subtitle).toMatch(/fewer minimum hits/)
    expect(
      emptyResultsCopy({ ...base, processed: true, type: 'edgeguard' }).title,
    ).toBe('No edgeguards found')
    expect(
      emptyResultsCopy({ ...base, processed: true, type: 'whatever' }).title,
    ).toBe('Nothing found')
  })

  it('a running step is running; a failed read offers a retry', () => {
    expect(emptyResultsCopy({ ...base, running: true }).title).toBe(
      'Running...',
    )
    const failed = emptyResultsCopy({
      ...base,
      readError: true,
      processed: true,
    })
    expect(failed.retry).toBe(true)
    expect(failed.title).toMatch(/Couldn't read/)
  })
})

describe('update banner text', () => {
  it('says plainly what an offline or unpublished feed means', () => {
    expect(updateErrorText('net::ERR_INTERNET_DISCONNECTED')).toMatch(
      /Couldn't reach the update server/,
    )
    expect(updateErrorText('getaddrinfo ENOTFOUND github.com')).toMatch(
      /Couldn't reach/,
    )
    expect(
      updateErrorText(
        'Cannot find latest.yml in the latest release artifacts (HttpError: 404)',
      ),
    ).toMatch(/No update information is published yet/)
    expect(updateErrorText('something odd')).toBe(
      "Couldn't check for updates. Try again later.",
    )
  })

  it('cuts the raw text for the Details line', () => {
    const long = `x ${'y'.repeat(2000)}`
    expect(updateErrorDetails(long).length).toBeLessThanOrEqual(400)
    expect(updateErrorDetails('a\n\nb')).toBe('a b')
  })
})

describe('statusPollDelay', () => {
  it('30 s normally, 15 s in maintenance, backing off after failures', () => {
    expect(statusPollDelay(0, false)).toBe(STATUS_POLL_MS)
    expect(statusPollDelay(0, true)).toBe(STATUS_POLL_MAINTENANCE_MS)
    expect(statusPollDelay(1, false)).toBe(60_000)
    expect(statusPollDelay(2, false)).toBe(120_000)
    expect(statusPollDelay(9, true)).toBe(300_000)
  })
})

describe('freeSpaceNote', () => {
  const GB = 1024 ** 3
  it('is silent when the free space is unknown', () => {
    expect(freeSpaceNote(10 * GB, undefined)).toBeNull()
    expect(freeSpaceNote(10 * GB, Number.NaN)).toBeNull()
    expect(freeSpaceNote(0, 5 * GB)).toBeNull()
  })

  it('warns when it will not fit, and when it is nearly all of it', () => {
    expect(freeSpaceNote(10 * GB, 4 * GB)).toMatchObject({ level: 'short' })
    expect(freeSpaceNote(10 * GB, 4 * GB)!.text).toMatch(
      /only .* is free on the drive with your Replay Library/,
    )
    expect(freeSpaceNote(9 * GB, 10 * GB)).toMatchObject({ level: 'tight' })
    expect(freeSpaceNote(1 * GB, 100 * GB)).toMatchObject({ level: 'ok' })
  })
})

describe('Find clips number boxes', () => {
  it('reads a decimal comma as a dot', () => {
    expect(normalizeDecimalInput('12,5')).toBe('12.5')
    expect(normalizeDecimalInput(' 4 5 ')).toBe('45')
    expect(damageValid(normalizeDecimalInput('12,5'))).toBe(true)
  })

  it('names what is wrong instead of silently not searching', () => {
    expect(limitsProblem('', '')).toBeNull()
    expect(limitsProblem('4', '45.5')).toBeNull()
    expect(limitsProblem('four', '')).toMatch(/Minimum hits/)
    expect(limitsProblem('', '1234')).toMatch(/Minimum damage/)
    expect(hitsValid('1000')).toBe(false)
  })
})

describe('compressed ISOs in the setup wizard', () => {
  it('knows the compressed disc formats, not a plain .iso', () => {
    expect(compressedImageKind('/games/Melee.rvz')).toBe('.rvz')
    expect(compressedImageKind('C:\\Games\\Melee.GCZ')).toBe('.gcz')
    expect(compressedImageKind('/g/melee.ciso')).toBe('.ciso')
    expect(compressedImageKind('/g/melee.iso')).toBeNull()
    expect(compressedImageKind('')).toBeNull()
    expect(compressedImageMessage('.rvz')).toMatch(/Dolphin plays it/)
  })
})

describe('downloadsBadgeCount', () => {
  it('counts what is running or needs the user, never canceled or finished', () => {
    const jobs = [
      { stage: 'downloading' },
      { stage: 'queued' },
      { stage: 'failed' },
      { stage: 'paused' },
      { stage: 'canceled' },
      { stage: 'completed' },
    ]
    expect(downloadsBadgeCount(jobs)).toBe(4)
    expect(downloadsBadgeCount([{ stage: 'canceled' }])).toBe(0)
  })
})

describe('grid keyboard moves', () => {
  it('arrows move by one and by a row, inside the list', () => {
    expect(gridKeyTarget('ArrowRight', 3, 5, 100)).toBe(4)
    expect(gridKeyTarget('ArrowLeft', 0, 5, 100)).toBe(0)
    expect(gridKeyTarget('ArrowDown', 3, 5, 100)).toBe(8)
    expect(gridKeyTarget('ArrowUp', 3, 5, 100)).toBe(0)
    expect(gridKeyTarget('ArrowDown', 98, 5, 100)).toBe(99)
    expect(gridKeyTarget('Home', 50, 5, 100)).toBe(0)
    expect(gridKeyTarget('End', 50, 5, 100)).toBe(99)
    expect(gridKeyTarget('x', 3, 5, 100)).toBeNull()
    expect(gridKeyTarget('ArrowRight', 0, 5, 0)).toBeNull()
  })

  it('scrolls only as far as needed to show the card', () => {
    // 100 px cells, 10 px padding, 90 px tiles, a 300 px view
    expect(scrollToShow(0, 3, 100, 10, 90, 0, 300)).toBe(0)
    expect(scrollToShow(3, 3, 100, 10, 90, 0, 300)).toBe(0)
    expect(scrollToShow(9, 3, 100, 10, 90, 0, 300)).toBe(110)
    expect(scrollToShow(0, 3, 100, 10, 90, 500, 300)).toBe(0)
  })
})

describe('describeWork', () => {
  it('names what is running, recording first', () => {
    expect(describeWork(noWork)).toBeNull()
    expect(describeWork({ ...noWork, filters: true })).toBe(
      'a filter is running',
    )
    expect(describeWork({ ...noWork, importing: true })).toBe(
      'an import is running',
    )
    expect(
      describeWork({ filters: true, importing: true, recording: true }),
    ).toBe('a recording is running')
  })
})

describe('settings number and path boxes', () => {
  it('clamps the numbers with a range and refuses a non-number', () => {
    expect(commitInt('numCPUs', '4')).toBe(4)
    expect(commitInt('numCPUs', '0')).toBe(1)
    expect(commitInt('numCPUs', '9999')).toBe(64)
    expect(commitInt('crf', '99')).toBe(51)
    expect(commitInt('numCPUs', '')).toBeNull()
    expect(commitInt('numCPUs', 'abc')).toBeNull()
    // A setting that may be negative keeps its sign.
    expect(commitInt('addStartFrames', '-30')).toBe(-30)
  })

  it('cleans a pasted quoted path', () => {
    expect(cleanPath('"C:\\Games\\Melee.iso"')).toBe('C:\\Games\\Melee.iso')
    expect(cleanPath("  '/home/me/x'  ")).toBe('/home/me/x')
    expect(cleanPath('/plain/path')).toBe('/plain/path')
  })
})
