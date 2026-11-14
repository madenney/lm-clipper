/** @jest-environment node */
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { COMBO_DETECTOR, EDGEGUARD_DETECTOR } from '../models/detectionCache'

// The detector cache keys results by COMBO_DETECTOR.version. If the combo
// detector changes, old cached combos must not be served: bump the version,
// then update the hash here. (Comment-only edits: just update the hash.)
const COMBOS_SOURCE_SHA256: Record<number, string> = {
  1: '1c99d193c0e78474',
}

describe('combo detector version', () => {
  it('is bumped whenever the detector source changes', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../vendor/replay-analysis/combos.ts'),
    )
    const sha = createHash('sha256').update(source).digest('hex').slice(0, 16)
    expect({ version: COMBO_DETECTOR.version, sha }).toEqual({
      version: COMBO_DETECTOR.version,
      sha: COMBOS_SOURCE_SHA256[COMBO_DETECTOR.version],
    })
  })
})

// Edgeguards: the detector plus the stage geometry and recovery data it uses.
const EDGEGUARD_SOURCES_SHA256: Record<number, string> = {
  1: '2f721d52829bf538',
}

describe('edgeguard detector version', () => {
  it('is bumped whenever the detector or its stage data change', () => {
    const h = createHash('sha256')
    for (const f of ['edgeguard.ts', 'stageGeometry.ts', 'recoveryData.ts'])
      h.update(
        fs.readFileSync(
          path.resolve(__dirname, '../vendor/replay-analysis', f),
        ),
      )
    const sha = h.digest('hex').slice(0, 16)
    expect({ version: EDGEGUARD_DETECTOR.version, sha }).toEqual({
      version: EDGEGUARD_DETECTOR.version,
      sha: EDGEGUARD_SOURCES_SHA256[EDGEGUARD_DETECTOR.version],
    })
  })
})
