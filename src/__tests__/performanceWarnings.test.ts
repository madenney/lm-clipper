import {
  freeDiskNote,
  hardwareSummary,
  performanceWarning,
  recommendedDolphins,
  recordingWarning,
} from '../renderer/lib/performanceWarnings'
import type { HardwareProfile } from '../constants/types'

const laptop: HardwareProfile = {
  threads: 8,
  ramGB: 8,
  gpu: 'Intel(R) UHD Graphics',
  integrated: true,
  freeDiskGB: 40,
  scratchFreeDiskGB: 6,
  detectedAt: '2026-10-13T00:00:00.000Z',
  picked: {
    numCPUs: 1,
    resolution: 2,
    videoPreset: 'veryfast',
    videoQualityMode: 'crf',
    crf: 20,
    playbackResolution: 2,
  },
}

describe('performanceWarning', () => {
  it('warns about Dolphins past half the CPU threads', () => {
    expect(recommendedDolphins(16)).toBe(8)
    expect(recommendedDolphins(1)).toBe(1)
    expect(performanceWarning('numCPUs', 8, 16)).toBeNull()
    expect(performanceWarning('numCPUs', 9, 16)).toMatch(/9 Dolphins is a lot/)
    expect(performanceWarning('numCPUs', 1, 1)).toBeNull()
  })

  it('warns about filter threads past the CPU threads', () => {
    expect(performanceWarning('numFilterThreads', 16, 16)).toBeNull()
    expect(performanceWarning('numFilterThreads', 17, 16)).toMatch(
      /more than this computer's 16/,
    )
  })

  it('ignores other settings and non-numbers', () => {
    expect(performanceWarning('slice', 999, 4)).toBeNull()
    expect(performanceWarning('numCPUs', 'abc', 4)).toBeNull()
  })
})

describe('with the detected hardware', () => {
  it('warns about Dolphins past the picked number', () => {
    expect(performanceWarning('numCPUs', 1, 8, laptop)).toBeNull()
    expect(performanceWarning('numCPUs', 2, 8, laptop)).toMatch(
      /more than we'd pick for this computer \(1: 8 CPU threads, 8 GB memory, integrated graphics\)/,
    )
  })

  it('warns about 4x and up on integrated graphics or <= 8 threads', () => {
    expect(
      recordingWarning('resolution', {
        resolution: 6,
        hardwareProfile: laptop,
      }),
    ).toBeNull()
    expect(
      recordingWarning('resolution', {
        resolution: 7,
        hardwareProfile: laptop,
      }),
    ).toMatch(/4x is very heavy for this computer \(integrated graphics/)
    expect(recordingWarning('resolution', { resolution: 9 }, 8)).toMatch(
      /8 CPU threads/,
    )
    expect(recordingWarning('resolution', { resolution: 9 }, 16)).toBeNull()
  })

  it('warns about lossless FFV1 at 2x and up', () => {
    expect(
      recordingWarning('recordingFormat', {
        recordingFormat: 'lossless',
        resolution: 2,
      }),
    ).toBeNull()
    expect(
      recordingWarning('recordingFormat', {
        recordingFormat: 'lossless',
        resolution: 4,
      }),
    ).toMatch(/very slow; long clips may be cut off/)
    expect(
      recordingWarning('recordingFormat', {
        recordingFormat: 'auto',
        resolution: 11,
      }),
    ).toBeNull()
  })

  it('on Windows, Fast is MPEG-4: only Lossless FFV1 warns at 2x and up, pointing at Fast', () => {
    const w = (recordingFormat: string, resolution: number) =>
      recordingWarning(
        'recordingFormat',
        { recordingFormat, resolution },
        16,
        'win32',
      )
    expect(w('auto', 2)).toBeNull()
    expect(w('auto', 4)).toBeNull()
    expect(w('lossless', 4)).toMatch(/only record lossless as FFV1.*Fast is/)
    expect(w('draft', 4)).toBeNull()
    expect(
      recordingWarning(
        'recordingFormat',
        { recordingFormat: 'auto', resolution: 4 },
        16,
        'linux',
      ),
    ).toBeNull()
  })

  it('notes free disk, and says when it is tight', () => {
    expect(freeDiskNote({ hardwareProfile: null })).toBeNull()
    const fine = freeDiskNote({
      resolution: 2,
      numCPUs: 1,
      hardwareProfile: laptop,
    })
    expect(fine).toEqual({
      text: '6.0 GB free for temporary recordings, 40.0 GB free in the output folder.',
      low: false,
    })
    const tight = freeDiskNote({
      resolution: 6,
      recordingFormat: 'auto',
      numCPUs: 2,
      hardwareProfile: laptop,
    })
    expect(tight?.low).toBe(true)
    expect(tight?.text).toMatch(/about 20 GB per minute/)
  })

  it('summarises the hardware and its picks', () => {
    expect(hardwareSummary(laptop)).toBe(
      '8 CPU threads · 8 GB memory · Intel(R) UHD Graphics (integrated). Picks: 1 Dolphin, 1x recording, veryfast encode, CRF 20.',
    )
    expect(hardwareSummary(null)).toBeNull()
  })
})
