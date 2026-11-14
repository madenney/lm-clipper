/**
 * @jest-environment node
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  classifyGpu,
  freeDiskGB,
  hardwareProfileOf,
  isWeakHardware,
  pickRecordingDefaults,
} from '../main/hardware'

jest.mock('electron', () => ({ app: {} }))

describe('pickRecordingDefaults', () => {
  it('gives a weak iGPU laptop one Dolphin at 1x, fast encode', () => {
    expect(
      pickRecordingDefaults({ threads: 8, ramGB: 8, integrated: true }),
    ).toEqual({
      numCPUs: 1,
      resolution: 2,
      videoPreset: 'veryfast',
      videoQualityMode: 'crf',
      crf: 20,
      playbackResolution: 2,
    })
  })

  it('gives a strong desktop up to 3 Dolphins at 2x', () => {
    expect(
      pickRecordingDefaults({ threads: 24, ramGB: 32, integrated: false }),
    ).toEqual({
      numCPUs: 3,
      resolution: 4,
      videoPreset: 'medium',
      videoQualityMode: 'crf',
      crf: 18,
      playbackResolution: 2,
    })
  })

  it('limits Dolphins by threads, memory and graphics', () => {
    // 12 threads → 3, 16 GB → floor(12/1.5)=8, discrete → 3
    expect(
      pickRecordingDefaults({ threads: 12, ramGB: 16, integrated: false })
        .numCPUs,
    ).toBe(3)
    // memory-bound: floor((7-4)/1.5) = 2, though threads allow 4
    expect(
      pickRecordingDefaults({ threads: 16, ramGB: 7, integrated: false })
        .numCPUs,
    ).toBe(2)
    // integrated graphics: one, however big the CPU
    expect(
      pickRecordingDefaults({ threads: 32, ramGB: 64, integrated: true })
        .numCPUs,
    ).toBe(1)
    // never zero
    expect(
      pickRecordingDefaults({ threads: 2, ramGB: 4, integrated: false })
        .numCPUs,
    ).toBe(1)
  })

  it('counts <= 8 threads, <= 8 GB or integrated graphics as weak', () => {
    expect(isWeakHardware({ threads: 8, ramGB: 32, integrated: false })).toBe(
      true,
    )
    expect(isWeakHardware({ threads: 16, ramGB: 8, integrated: false })).toBe(
      true,
    )
    expect(isWeakHardware({ threads: 16, ramGB: 16, integrated: true })).toBe(
      true,
    )
    expect(isWeakHardware({ threads: 12, ramGB: 16, integrated: false })).toBe(
      false,
    )
  })
})

describe('classifyGpu', () => {
  it('treats Intel graphics alone as integrated', () => {
    expect(
      classifyGpu({
        gpuDevice: [
          {
            vendorId: 0x8086,
            deviceId: 0x9a49,
            active: true,
            deviceString: 'Intel(R) Iris(R) Xe Graphics',
          },
        ],
      }),
    ).toEqual({ gpu: 'Intel(R) Iris(R) Xe Graphics', integrated: true })
  })

  it('treats an AMD APU as integrated and a Radeon RX as discrete', () => {
    expect(
      classifyGpu({
        gpuDevice: [
          { vendorId: 0x1002, deviceString: 'AMD Radeon(TM) Graphics' },
        ],
      }).integrated,
    ).toBe(true)
    expect(
      classifyGpu({
        gpuDevice: [
          { vendorId: 0x1002, deviceString: 'AMD Radeon RX 6700 XT' },
        ],
      }).integrated,
    ).toBe(false)
  })

  it('a laptop with Intel + NVIDIA counts as discrete', () => {
    expect(
      classifyGpu({
        gpuDevice: [
          { vendorId: 0x8086, deviceId: 0x46a6, active: true },
          { vendorId: 0x10de, deviceId: 0x25a0, active: false },
        ],
      }),
    ).toEqual({ gpu: 'NVIDIA', integrated: false })
  })

  it('Intel Arc cards are discrete', () => {
    expect(
      classifyGpu({ gpuDevice: [{ vendorId: 0x8086, deviceId: 0x56a0 }] })
        .integrated,
    ).toBe(false)
    expect(
      classifyGpu({
        gpuDevice: [
          { vendorId: 0x8086, deviceString: 'Intel(R) Arc(TM) A770 Graphics' },
        ],
      }).integrated,
    ).toBe(false)
  })

  it('no GPU info: unknown, not integrated', () => {
    expect(classifyGpu(null)).toEqual({
      gpu: 'Unknown graphics',
      integrated: false,
    })
    expect(classifyGpu({ gpuDevice: [{ vendorId: 0, deviceId: 0 }] })).toEqual({
      gpu: 'Unknown graphics',
      integrated: false,
    })
  })
})

describe('freeDiskGB / hardwareProfileOf', () => {
  it('measures the nearest existing folder of a path not made yet', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hw-'))
    try {
      const gb = await freeDiskGB(path.join(dir, 'not', 'yet'))
      const hasStatfs = !!(fs.promises as unknown as { statfs?: unknown })
        .statfs
      // A number (>= 0) where Node has statfs, else null.
      expect(hasStatfs ? typeof gb === 'number' && gb >= 0 : gb === null).toBe(
        true,
      )
      expect(await freeDiskGB('')).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records what was detected and picked', () => {
    const p = hardwareProfileOf({
      threads: 8,
      ramGB: 16,
      gpu: 'Intel UHD',
      integrated: true,
      freeDiskGB: 50,
    })
    expect(p).toMatchObject({
      threads: 8,
      ramGB: 16,
      gpu: 'Intel UHD',
      integrated: true,
      freeDiskGB: 50,
      picked: { numCPUs: 1, resolution: 2 },
    })
    expect(Number.isNaN(Date.parse(p.detectedAt))).toBe(false)
  })
})
