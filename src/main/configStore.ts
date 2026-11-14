import { ConfigInterface } from '../constants/types'
import { OWNER_CONFIG_KEYS, OWNER_SECRET_KEYS } from '../owner/channels'

// Config-value migrations applied on load. Older configs stored `resolution` as
// a string label ('2x') and several numeric fields as strings; coerce them to
// the numbers the rest of the app expects. Pure + mutating: returns the same
// object for convenience. Extracted from the controller constructor so it can
// be unit-tested in isolation (see src/__tests__/configStore.test.ts).

// Legacy 'Nx' resolution label -> Dolphin internal-resolution scale factor.
export const RESOLUTION_LABELS: { [key: string]: number } = {
  '1x': 2,
  '1.5x': 3,
  '2x': 4,
  '2.5x': 5,
  '3x': 6,
  '4x': 7,
  '5x': 8,
  '6x': 9,
  '7x': 10,
  '8x': 11,
}

// Fields that must be numbers but may have been persisted as strings.
export const INT_KEYS = [
  'numCPUs',
  'slice',
  'bitrateKbps',
  'addStartFrames',
  'addEndFrames',
  'lastClipOffset',
  'numFilterThreads',
  'dolphinCutoff',
]

export function migrateConfigTypes(config: any): ConfigInterface {
  if (
    typeof config.resolution === 'string' &&
    RESOLUTION_LABELS[config.resolution]
  ) {
    config.resolution = RESOLUTION_LABELS[config.resolution]
  }
  // "Show Dolphin While Recording" became "Hide Recording Windows" (on by
  // default): whoever had Dolphin shown keeps it shown. Only an old config has
  // the key (it is no longer a default), so this runs once.
  if (typeof config.showRecordingDolphin === 'boolean') {
    if (config.showRecordingDolphin) config.hideRecordingWindows = false
    delete config.showRecordingDolphin
  }
  INT_KEYS.forEach((key) => {
    if (typeof config[key] === 'string') {
      const parsed = parseInt(config[key], 10)
      if (!Number.isNaN(parsed)) {
        config[key] = parsed
      }
    }
  })
  return config
}

// Secrets kept in the config that the renderer never needs to see (owner tools'
// keys, used by the main process only).
export const SECRET_CONFIG_KEYS = [...OWNER_SECRET_KEYS]

/** The config as sent to the renderer: secrets removed. */
export function rendererConfig(config: ConfigInterface): ConfigInterface {
  const copy = { ...config }
  for (const key of SECRET_CONFIG_KEYS) delete copy[key]
  return copy
}

/** Keys the renderer's generic updateConfig may not write (owner tools save
 *  their own through their own validated request). */
export function rendererMayWrite(key: unknown): boolean {
  return typeof key === 'string' && !OWNER_CONFIG_KEYS.includes(key)
}
