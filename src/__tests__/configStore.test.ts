/**
 * @jest-environment node
 */
import {
  migrateConfigTypes,
  RESOLUTION_LABELS,
  INT_KEYS,
} from '../main/configStore'

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
