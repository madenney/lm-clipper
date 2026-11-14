/**
 * @jest-environment node
 *
 * Tests for anonymous usage telemetry (src/main/telemetry.ts). The contract:
 * `track()` must never throw and must NOT make a network request when the user
 * has opted out (`sendAnonymousUsage === false`) or before an `installId`
 * exists. When enabled, it POSTs a JSON body carrying the event + installId.
 *
 * `https.request` and electron's `app.getVersion` are mocked so nothing leaves
 * the test process.
 */

// Mock https BEFORE importing the module under test.
const mockReq = {
  on: jest.fn(),
  write: jest.fn(),
  end: jest.fn(),
  destroy: jest.fn(),
}
jest.mock('https', () => ({
  request: jest.fn(() => mockReq),
}))

const mockApp = { isPackaged: true }
jest.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9-test',
    get isPackaged() {
      return mockApp.isPackaged
    },
  },
}))

// eslint-disable-next-line import/first
import https from 'https'
// eslint-disable-next-line import/first
import {
  initTelemetry,
  track,
  applyUsageConsent,
  releaseHeldTelemetry,
  reportStartupTelemetry,
  telemetrySuppressedReason,
} from '../main/telemetry'
// eslint-disable-next-line import/first
import type { ConfigInterface } from '../constants/types'

const httpsRequest = https.request as unknown as jest.Mock

// Build a minimal ConfigInterface; only the telemetry-relevant keys matter.
function makeConfig(overrides: Partial<ConfigInterface>): ConfigInterface {
  return {
    sendAnonymousUsage: true,
    installId: 'install-abc',
    ...overrides,
  } as ConfigInterface
}

beforeEach(() => {
  mockApp.isPackaged = true
  for (const k of Object.keys(process.env))
    if (
      k === 'LM_CLIPPER_TEST_HOME' ||
      k === 'LM_CLIPPER_TELEMETRY_FORCE' ||
      k.startsWith('LM_CLIPPER_AUTORUN_')
    )
      delete process.env[k]
  httpsRequest.mockClear()
  mockReq.on.mockClear()
  mockReq.write.mockClear()
  mockReq.end.mockClear()
})

describe('track — opt-out / missing installId (no network)', () => {
  it('does NOT call https.request when sendAnonymousUsage === false', () => {
    initTelemetry({
      getConfig: () => makeConfig({ sendAnonymousUsage: false }),
    })
    expect(() => track('app_open')).not.toThrow()
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('does NOT call https.request when installId is empty', () => {
    initTelemetry({ getConfig: () => makeConfig({ installId: '' }) })
    expect(() => track('install')).not.toThrow()
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('does NOT call https.request when installId is absent', () => {
    initTelemetry({
      getConfig: () => makeConfig({ installId: undefined }),
    })
    expect(() => track('filter_run')).not.toThrow()
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('does NOT throw or POST when getConfig is never initialized', () => {
    // Re-init with a config provider that returns a null-ish config.
    initTelemetry({ getConfig: () => null as unknown as ConfigInterface })
    expect(() => track('video_created')).not.toThrow()
    expect(httpsRequest).not.toHaveBeenCalled()
  })
})

describe('track — enabled (POSTs a JSON body)', () => {
  beforeEach(() => {
    initTelemetry({
      getConfig: () =>
        makeConfig({
          sendAnonymousUsage: true,
          installId: 'install-xyz',
          consentNoticeSeen: true,
        }),
    })
  })

  it('calls https.request exactly once with a POST', () => {
    track('import_completed', { files: 42 })
    expect(httpsRequest).toHaveBeenCalledTimes(1)
    const [endpoint, opts] = httpsRequest.mock.calls[0]
    expect(typeof endpoint).toBe('string')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
  })

  it('writes a JSON body containing the event, installId, version and data', () => {
    track('video_created', { duration: 12 })
    expect(mockReq.write).toHaveBeenCalledTimes(1)
    const written = mockReq.write.mock.calls[0][0]
    const parsed = JSON.parse(written)
    expect(parsed.event).toBe('video_created')
    expect(parsed.installId).toBe('install-xyz')
    expect(parsed.appVersion).toBe('9.9.9-test')
    expect(parsed.data).toEqual({ duration: 12 })
    // Common fields are auto-attached.
    expect(parsed.os).toBe(process.platform)
    expect(parsed.arch).toBe(process.arch)
    expect(typeof parsed.ts).toBe('string')
  })

  it('finalizes the request (end called) and registers error/timeout handlers', () => {
    track('app_open')
    expect(mockReq.end).toHaveBeenCalledTimes(1)
    const events = mockReq.on.mock.calls.map((c) => c[0])
    expect(events).toContain('error')
    expect(events).toContain('timeout')
  })

  it('never throws even if https.request itself blows up', () => {
    httpsRequest.mockImplementationOnce(() => {
      throw new Error('socket exploded')
    })
    expect(() => track('filter_run')).not.toThrow()
  })
})

/**
 * The usage-data toggle reports its own change. track() reads the LIVE config
 * on every call and drops everything while the flag is off, so the report has
 * to straddle the flip: opt-out BEFORE it, opt-in AFTER it. Reverse either and
 * the event vanishes silently.
 *
 * These drive applyUsageConsent() — the real function the controller calls —
 * with a config the `flip` callback actually mutates, so a regression in the
 * ordering fails here. Asserting against a re-implementation of the sequence
 * would pass no matter what the shipping code does.
 */
describe('applyUsageConsent — reports the toggle around the flip', () => {
  let config: ConfigInterface

  const sentEvents = () =>
    mockReq.write.mock.calls.map((c) => JSON.parse(c[0]).event)

  beforeEach(() => {
    config = makeConfig({ sendAnonymousUsage: true, installId: 'install-xyz' })
    initTelemetry({ getConfig: () => config })
  })

  // flip() mirrors the controller: it mutates the same config track() reads.
  const flipTo = (v: boolean) => () => {
    config.sendAnonymousUsage = v
  }

  it('sends usage_opt_out when turning it off, and applies the change', () => {
    applyUsageConsent(true, false, flipTo(false))
    expect(sentEvents()).toEqual(['usage_opt_out'])
    expect(config.sendAnonymousUsage).toBe(false)
  })

  it('sends usage_opt_in when turning it back on, and applies the change', () => {
    config.sendAnonymousUsage = false
    applyUsageConsent(false, true, flipTo(true))
    expect(sentEvents()).toEqual(['usage_opt_in'])
    expect(config.sendAnonymousUsage).toBe(true)
  })

  it('sends nothing when the value is unchanged (on -> on)', () => {
    applyUsageConsent(true, true, flipTo(true))
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('sends nothing when the value is unchanged (off -> off)', () => {
    config.sendAnonymousUsage = false
    applyUsageConsent(false, false, flipTo(false))
    expect(httpsRequest).not.toHaveBeenCalled()
  })

  it('still applies the change when telemetry is a no-op', () => {
    config.installId = ''
    applyUsageConsent(true, false, flipTo(false))
    expect(httpsRequest).not.toHaveBeenCalled()
    expect(config.sendAnonymousUsage).toBe(false)
  })

  // The promise made on the privacy page: after opting out, nothing at all.
  it('stays silent for every event type once opted out', () => {
    applyUsageConsent(true, false, flipTo(false))
    httpsRequest.mockClear()
    mockReq.write.mockClear()
    track('install')
    track('app_open')
    track('video_created', { clips: 3, durationSec: 12 })
    track('import_completed', { added: 100, failed: 0 })
    track('filter_run', { filterType: 'combo', durationMs: 5 })
    track('usage_opt_out')
    expect(httpsRequest).not.toHaveBeenCalled()
  })
})

describe('first-launch pings wait for the usage-stats notice', () => {
  it('holds install and app_open until the notice was shown, then sends once', () => {
    const config = makeConfig({ consentNoticeSeen: false })
    initTelemetry({ getConfig: () => config })
    track('install')
    track('app_open')
    track('app_open')
    expect(httpsRequest).not.toHaveBeenCalled()
    // Other events are not held.
    track('import_completed', { files: 1 })
    expect(httpsRequest).toHaveBeenCalledTimes(1)
    httpsRequest.mockClear()
    config.consentNoticeSeen = true
    releaseHeldTelemetry()
    const sent = mockReq.write.mock.calls.map((c) => JSON.parse(c[0]).event)
    expect(sent.filter((e) => e === 'install')).toHaveLength(1)
    expect(sent.filter((e) => e === 'app_open')).toHaveLength(1)
  })

  it('sends nothing held when the user opted out before the notice', () => {
    const config = makeConfig({ consentNoticeSeen: false })
    initTelemetry({ getConfig: () => config })
    track('install')
    config.sendAnonymousUsage = false
    config.consentNoticeSeen = true
    httpsRequest.mockClear()
    releaseHeldTelemetry()
    expect(httpsRequest).not.toHaveBeenCalled()
  })
})

describe('dev, rig and test runs are not users (analytics review F7)', () => {
  const cfg = () => makeConfig({ consentNoticeSeen: true })
  afterEach(() => {
    delete process.env.LM_CLIPPER_TEST_HOME
    delete process.env.LM_CLIPPER_AUTORUN_WORKFLOW
    delete process.env.LM_CLIPPER_TELEMETRY_FORCE
  })

  it('sends from a packaged build', () => {
    initTelemetry({ getConfig: cfg })
    track('app_open')
    expect(httpsRequest).toHaveBeenCalledTimes(1)
    expect(telemetrySuppressedReason(cfg())).toBeNull()
  })
  it('sends nothing from a build that is not packaged', () => {
    mockApp.isPackaged = false
    initTelemetry({ getConfig: cfg })
    track('app_open')
    expect(httpsRequest).not.toHaveBeenCalled()
    expect(telemetrySuppressedReason(cfg())).toBe('not-packaged')
  })
  it('sends nothing under the win-rig test home or autorun flags', () => {
    initTelemetry({ getConfig: cfg })
    process.env.LM_CLIPPER_TEST_HOME = '/tmp/home'
    track('app_open')
    delete process.env.LM_CLIPPER_TEST_HOME
    process.env.LM_CLIPPER_AUTORUN_WORKFLOW = '1'
    track('video_created', { clips: 1 })
    expect(httpsRequest).not.toHaveBeenCalled()
  })
  it('sends nothing with testMode on', () => {
    initTelemetry({
      getConfig: () => makeConfig({ consentNoticeSeen: true, testMode: true }),
    })
    track('app_open')
    expect(httpsRequest).not.toHaveBeenCalled()
  })
  it('lets a developer force it on purpose', () => {
    mockApp.isPackaged = false
    process.env.LM_CLIPPER_TELEMETRY_FORCE = '1'
    initTelemetry({ getConfig: cfg })
    track('app_open')
    expect(httpsRequest).toHaveBeenCalledTimes(1)
  })
})

/** Make https.request answer with a status code (or fail), like the real thing. */
function respondWith(status: number | 'error') {
  httpsRequest.mockImplementationOnce((_url, _opts, cb) => {
    const req = {
      on: jest.fn((evt: string, fn: () => void) => {
        if (evt === 'error' && status === 'error') setImmediate(fn)
      }),
      write: jest.fn(),
      end: jest.fn(() => {
        if (status !== 'error')
          setImmediate(() => cb({ statusCode: status, resume: jest.fn() }))
      }),
      destroy: jest.fn(),
    }
    return req
  })
}
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('launch pings are marked sent only once acknowledged (F19)', () => {
  let config: ConfigInterface
  const save = jest.fn()
  beforeEach(() => {
    save.mockClear()
    config = makeConfig({ consentNoticeSeen: true, installPingPending: true })
    initTelemetry({ getConfig: () => config, saveConfig: save })
  })

  it('keeps install pending and the day unmarked when the request fails', async () => {
    respondWith('error')
    respondWith('error')
    reportStartupTelemetry('1.0.0', new Date('2026-11-12T10:00:00Z'))
    await tick()
    expect(config.installPingPending).toBe(true)
    expect(config.lastUsagePing).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
  })
  it('keeps them unmarked on a non-2xx answer', async () => {
    respondWith(503)
    respondWith(429)
    reportStartupTelemetry('1.0.0', new Date('2026-11-12T10:00:00Z'))
    await tick()
    expect(config.installPingPending).toBe(true)
    expect(config.lastUsagePing).toBeUndefined()
  })
  it('marks both after 2xx and does not repeat the same day and version', async () => {
    respondWith(204)
    respondWith(204)
    reportStartupTelemetry('1.0.0', new Date('2026-11-12T10:00:00Z'))
    await tick()
    expect(config.installPingPending).toBe(false)
    expect(config.lastUsagePing).toBe('2026-11-12')
    expect(config.lastUsagePingVersion).toBe('1.0.0')
    expect(save).toHaveBeenCalled()
    httpsRequest.mockClear()
    reportStartupTelemetry('1.0.0', new Date('2026-11-12T23:00:00Z'))
    expect(httpsRequest).not.toHaveBeenCalled()
  })
  it('sends app_open again for a new day and for a new version', async () => {
    config.installPingPending = false
    config.lastUsagePing = '2026-11-12'
    config.lastUsagePingVersion = '1.0.0'
    reportStartupTelemetry('1.0.0', new Date('2026-11-13T00:01:00Z'))
    expect(httpsRequest).toHaveBeenCalledTimes(1)
    httpsRequest.mockClear()
    reportStartupTelemetry('1.1.0', new Date('2026-11-12T12:00:00Z'))
    expect(httpsRequest).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mockReq.write.mock.calls.at(-1)![0]).event).toBe(
      'app_open',
    )
  })
  it('keeps an install ping that was held for the notice, and sends it after', async () => {
    config.consentNoticeSeen = false
    config.lastUsagePing = '2026-11-12'
    config.lastUsagePingVersion = '1.0.0'
    reportStartupTelemetry('1.0.0', new Date('2026-11-12T10:00:00Z'))
    expect(httpsRequest).not.toHaveBeenCalled()
    expect(config.installPingPending).toBe(true)
    respondWith(204)
    config.consentNoticeSeen = true
    releaseHeldTelemetry()
    await tick()
    expect(config.installPingPending).toBe(false)
  })
})

describe('flushTelemetry', () => {
  // A fresh module, so requests left hanging by the tests above are not in flight here.
  const fresh = () => {
    let mod: typeof import('../main/telemetry')
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      mod = require('../main/telemetry')
    })
    mod!.initTelemetry({
      getConfig: () => makeConfig({ consentNoticeSeen: true }),
    })
    return mod!
  }
  it('resolves at once with nothing in flight and waits for a request that is', async () => {
    const t = fresh()
    await t.flushTelemetry(50)
    respondWith(204)
    t.track('app_open')
    const t0 = Date.now()
    await t.flushTelemetry(1000)
    expect(Date.now() - t0).toBeLessThan(500)
  })
  it('gives up after the timeout when the request never finishes', async () => {
    const t = fresh()
    t.track('app_open') // the default mock never answers
    const t0 = Date.now()
    await t.flushTelemetry(40)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30)
  })
})
