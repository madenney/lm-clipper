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

jest.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9-test',
  },
}))

// eslint-disable-next-line import/first
import https from 'https'
// eslint-disable-next-line import/first
import { initTelemetry, track, applyUsageConsent } from '../main/telemetry'
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
        makeConfig({ sendAnonymousUsage: true, installId: 'install-xyz' }),
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
