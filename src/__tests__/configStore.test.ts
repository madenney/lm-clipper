/**
 * @jest-environment node
 */
import {
  migrateConfigTypes,
  RESOLUTION_LABELS,
  INT_KEYS,
} from '../main/configStore'
import { config as defaultConfig } from '../constants/defaults'
import { settingForPlatform, videoConfig } from '../constants/config'

describe('migrateConfigTypes', () => {
  it("maps a legacy 'Nx' resolution label to its scale factor", () => {
    expect(migrateConfigTypes({ resolution: '2x' }).resolution).toBe(4)
    expect(migrateConfigTypes({ resolution: '1x' }).resolution).toBe(2)
    expect(migrateConfigTypes({ resolution: '8x' }).resolution).toBe(11)
  })

  it('leaves a numeric resolution untouched', () => {
    expect(migrateConfigTypes({ resolution: 6 }).resolution).toBe(6)
  })

  it('leaves an unknown resolution string untouched', () => {
    expect(migrateConfigTypes({ resolution: '99x' }).resolution).toBe('99x')
  })

  it('coerces string-valued int fields to numbers', () => {
    const out = migrateConfigTypes({
      numCPUs: '4',
      slice: '100',
      bitrateKbps: '8000',
    }) as any
    expect(out.numCPUs).toBe(4)
    expect(out.slice).toBe(100)
    expect(out.bitrateKbps).toBe(8000)
  })

  it('leaves already-numeric int fields and non-numeric strings as-is', () => {
    const out = migrateConfigTypes({ numCPUs: 8, slice: 'all' }) as any
    expect(out.numCPUs).toBe(8)
    expect(out.slice).toBe('all') // parseInt('all') is NaN -> not assigned
  })

  it('mutates and returns the same object', () => {
    const cfg: any = { resolution: '3x' }
    expect(migrateConfigTypes(cfg)).toBe(cfg)
  })

  it('exposes the label map and int-key list it operates on', () => {
    expect(RESOLUTION_LABELS['4x']).toBe(7)
    expect(INT_KEYS).toContain('numFilterThreads')
  })
})

describe('Show Dolphin While Recording -> Hide Recording Windows', () => {
  // The controller merges defaults under the saved config, then migrates.
  const load = (saved: Record<string, unknown>) =>
    migrateConfigTypes({ ...defaultConfig, ...saved }) as any

  it('defaults to hidden, with no old key left', () => {
    const out = load({})
    expect(out.hideRecordingWindows).toBe(true)
    expect('showRecordingDolphin' in out).toBe(false)
  })

  it('keeps Dolphin shown for someone who had it shown', () => {
    const out = load({ showRecordingDolphin: true })
    expect(out.hideRecordingWindows).toBe(false)
    expect('showRecordingDolphin' in out).toBe(false)
  })

  it('hides for someone who had it off (the old default)', () => {
    const out = load({ showRecordingDolphin: false })
    expect(out.hideRecordingWindows).toBe(true)
    expect('showRecordingDolphin' in out).toBe(false)
  })

  it('leaves a saved choice alone on the next load', () => {
    expect(load({ hideRecordingWindows: false }).hideRecordingWindows).toBe(
      false,
    )
    const once = load({ showRecordingDolphin: true })
    expect(load(once).hideRecordingWindows).toBe(false)
  })
})

describe('settingForPlatform', () => {
  const format = videoConfig.find((c) => c.id === 'recordingFormat')!
  const labelOf = (platform: string | undefined) =>
    (
      settingForPlatform(format, platform) as {
        options: { value: string; label: string }[]
      }
    ).options.find((o) => o.value === 'auto')!.label

  it('calls Windows "auto" Fast (it is MPEG-4 there), lossless elsewhere', () => {
    expect(labelOf('win32')).toBe('Fast (high quality, recommended)')
    expect(labelOf('linux')).toBe('Fast lossless (recommended)')
    expect(labelOf('darwin')).toBe('Fast lossless (recommended)')
    expect(labelOf(undefined)).toBe('Fast lossless (recommended)')
    expect(settingForPlatform(format, 'win32').tooltip).toMatch(
      /MPEG-4 at 150 Mb\/s/,
    )
    expect(settingForPlatform(format, 'win32').tooltip).not.toMatch(
      /Fast lossless/,
    )
  })

  it('has the hide setting on by default in Settings', () => {
    const hide = videoConfig.find((c) => c.id === 'hideRecordingWindows')!
    expect(hide.default).toBe(true)
    expect(hide.category).toBe('recording')
  })
})
