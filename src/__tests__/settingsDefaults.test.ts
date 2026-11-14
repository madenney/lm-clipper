/**
 * @jest-environment node
 *
 * Settings (constants/config.ts videoConfig) shows a default for each setting;
 * a new install and Reset apply constants/defaults.ts. They must agree, or the
 * Settings page describes a default nobody gets.
 */
import { videoConfig } from '../constants/config'
import { config as defaults } from '../constants/defaults'

describe('Settings defaults match the applied defaults', () => {
  const entries = (videoConfig as { id: string; default?: unknown }[]).filter(
    (c) => 'default' in c && c.id in defaults,
  )

  it.each(entries.map((c) => [c.id, c.default]))('%s', (id, shown) => {
    expect(shown).toEqual((defaults as Record<string, unknown>)[id as string])
  })

  it('has the scratch folder and hardware profile keys', () => {
    expect(defaults.scratchPath).toBe('')
    expect(defaults.hardwareProfile).toBeNull()
    const scratch = (videoConfig as { id: string; type?: string }[]).find(
      (c) => c.id === 'scratchPath',
    )
    expect(scratch?.type).toBe('openDirectory')
  })
})
