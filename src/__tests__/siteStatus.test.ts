import {
  describeForecast,
  describeQueue,
  parseDatabaseEstimate,
  parseSiteStatus,
} from '../constants/database'

describe('site status and download forecasts', () => {
  it('reads the live status and ignores junk', () => {
    expect(
      parseSiteStatus({
        notice: { text: '  Launch day!  ', level: 'warning' },
        database: 'up',
        queue: { building: 2, waiting: 14, clearsInSec: 1500, paused: null },
      }),
    ).toEqual({
      notice: { text: 'Launch day!', level: 'warning' },
      database: 'up',
      maintenance: null,
      queue: { building: 2, waiting: 14, clearsInSec: 1500, paused: null },
    })
    expect(
      parseSiteStatus({ notice: { text: '' }, database: 'down', queue: null }),
    ).toEqual({
      notice: null,
      database: 'down',
      maintenance: null,
      queue: null,
    })
    expect(parseSiteStatus('nope')).toBeNull()
  })

  it("reads the website's Clipper versions and tolerates a future shape (XC-4)", () => {
    const base = { notice: null, database: 'up', queue: null }
    expect(
      parseSiteStatus({
        ...base,
        clipper: {
          latest: '3.2.0',
          minimum: '3.0.1',
          message: ' Please update ',
          somethingNew: { a: 1 },
        },
      })?.clipper,
    ).toEqual({ latest: '3.2.0', minimum: '3.0.1', message: 'Please update' })
    // Junk versions are dropped, a non-object is ignored, nothing throws.
    expect(
      parseSiteStatus({ ...base, clipper: { latest: 'newest', minimum: 3 } })
        ?.clipper,
    ).toEqual({ latest: undefined, minimum: undefined, message: undefined })
    expect(parseSiteStatus({ ...base, clipper: 'x' })?.clipper).toBeUndefined()
    expect(parseSiteStatus(base)?.clipper).toBeUndefined()
  })

  it('reads maintenance: the message (or the default) and when it started', () => {
    expect(
      parseSiteStatus({
        notice: null,
        database: 'down',
        maintenance: {
          message: '  Moving servers ',
          since: '2026-10-14T18:00:00.000Z',
        },
        queue: null,
      })?.maintenance,
    ).toEqual({ message: 'Moving servers', since: '2026-10-14T18:00:00.000Z' })
    expect(
      parseSiteStatus({ database: 'down', maintenance: { message: '' } })
        ?.maintenance,
    ).toEqual({ message: 'Down for maintenance', since: null })
  })

  it('says how long the queue is', () => {
    expect(
      describeQueue({ building: 0, waiting: 0, clearsInSec: 0, paused: null }),
    ).toBe('Server downloads: no wait right now')
    expect(
      describeQueue({
        building: 2,
        waiting: 14,
        clearsInSec: 1500,
        paused: null,
      }),
    ).toBe('Server downloads: 14 waiting · clears in about 25 min')
  })

  it('carries the forecast through an estimate and words it', () => {
    const e = parseDatabaseEstimate({
      replayCount: 40,
      rawSize: 1,
      estimatedSlpzSize: 1,
      queue: { reusable: null, ahead: 3, readySec: 600, paused: null },
    })
    expect(describeForecast(e.queue!)).toBe(
      'If you download this now: ready in about 10 min · 3 downloads ahead of you.',
    )
    const shared = parseDatabaseEstimate({
      replayCount: 1,
      rawSize: 1,
      estimatedSlpzSize: 1,
      queue: {
        reusable: { jobId: 'x', status: 'bundling' },
        ahead: 0,
        readySec: 900,
      },
    })
    expect(describeForecast(shared.queue!)).toMatch(/share their download/)
  })
})
