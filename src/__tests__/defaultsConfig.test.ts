/**
 * @jest-environment node
 *
 * Guards the default `config` object (src/constants/defaults.ts) against
 * missing keys — especially the telemetry/consent keys added recently. A
 * fresh install seeds its config from this object, so a dropped key here means
 * a brand-new user starts with an undefined value (e.g. an undefined
 * `sendAnonymousUsage`, or a missing `approvedCustomCodeHashes` array that then
 * throws on `.includes`).
 */
import { config } from '../constants/defaults'

describe('default config — required keys present', () => {
  // A representative slice of ConfigInterface's non-optional keys. Not
  // exhaustive (ConfigInterface has a `[key: string]: any` escape hatch), but
  // covers the load-bearing video/import/path settings.
  const requiredKeys = [
    'recentProjects',
    'outputPath',
    'lastArchivePath',
    'hideHud',
    'resolution',
    'playbackResolution',
    'bitrateKbps',
    'numCPUs',
    'numFilterThreads',
    'ssbmIsoPath',
    'dolphinPath',
    'concatenate',
    'convertToMp4',
    'savedCustomFilters',
    'customGeckoCodes',
    'slpzMode',
  ]

  it.each(requiredKeys)('defines "%s"', (key) => {
    expect(config).toHaveProperty(key)
    expect((config as Record<string, unknown>)[key]).not.toBeUndefined()
  })
})

describe('default config — recently-added telemetry / consent keys', () => {
  it('sendAnonymousUsage is present and a boolean', () => {
    expect(config).toHaveProperty('sendAnonymousUsage')
    expect(typeof config.sendAnonymousUsage).toBe('boolean')
  })

  it('installId is present and a string (empty until first run generates one)', () => {
    expect(config).toHaveProperty('installId')
    expect(typeof config.installId).toBe('string')
    expect(config.installId).toBe('')
  })

  it('consentNoticeSeen defaults to false (disclosure not yet dismissed)', () => {
    expect(config).toHaveProperty('consentNoticeSeen')
    expect(config.consentNoticeSeen).toBe(false)
  })

  it('approvedCustomCodeHashes is present and an empty array', () => {
    expect(config).toHaveProperty('approvedCustomCodeHashes')
    expect(Array.isArray(config.approvedCustomCodeHashes)).toBe(true)
    expect(config.approvedCustomCodeHashes).toHaveLength(0)
  })
})

describe('default config — sane default values', () => {
  it('recentProjects starts empty', () => {
    expect(config.recentProjects).toEqual([])
  })

  it('numFilterThreads / numCPUs are positive integers', () => {
    expect(config.numCPUs).toBeGreaterThan(0)
    expect(Number.isInteger(config.numCPUs)).toBe(true)
    expect(config.numFilterThreads).toBeGreaterThan(0)
    expect(Number.isInteger(config.numFilterThreads)).toBe(true)
  })

  it('slpzMode is one of the allowed modes', () => {
    expect(['ask', 'extract', 'replace']).toContain(config.slpzMode)
  })

  it('ships built-in custom filters (a non-empty array)', () => {
    expect(Array.isArray(config.savedCustomFilters)).toBe(true)
    expect(config.savedCustomFilters.length).toBeGreaterThan(0)
    // Every shipped filter is flagged builtIn.
    expect(config.savedCustomFilters.every((f) => f.builtIn === true)).toBe(true)
  })
})

describe('config merge / backfill behavior (the controller load pattern)', () => {
  // controller.ts merges a user's on-disk config over the defaults with a
  // spread: `{ ...defaultConfig, ...savedConfig }`. The merge itself is inline
  // in the (electron-bound) controller, so we assert the property the spread
  // relies on: a stale on-disk config that predates the new keys still ends up
  // with them after merging over defaults.
  it('spread-merge backfills keys absent from an older saved config', () => {
    const oldSaved = {
      // an "old" config that never had the telemetry keys
      outputPath: '/my/output',
      sendAnonymousUsage: undefined as unknown as boolean,
    }
    // Drop explicitly-undefined keys the way JSON.parse(readFileSync) would
    // (an old file simply wouldn't contain them at all).
    const cleaned = Object.fromEntries(
      Object.entries(oldSaved).filter(([, v]) => v !== undefined),
    )
    const merged = { ...config, ...cleaned }

    expect(merged.outputPath).toBe('/my/output') // user value wins
    expect(merged.sendAnonymousUsage).toBe(config.sendAnonymousUsage) // backfilled
    expect(merged.approvedCustomCodeHashes).toEqual([]) // backfilled
    expect(merged.consentNoticeSeen).toBe(false) // backfilled
  })
})
