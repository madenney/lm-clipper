import { ConfigInterface } from '../constants/types'

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
