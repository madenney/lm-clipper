/**
 * What this computer can handle, and the recording settings that suit it.
 *
 * A new install used to start everyone on the same numbers (2 Dolphins, 2x),
 * which a weak laptop with integrated graphics can't keep up with: Dolphin drops
 * frames, recordings run past their time limit or run out of memory. On first
 * run (and on Reset / "Pick settings for this computer") we look at the CPU
 * threads, memory, graphics and free disk, and pick from that.
 *
 * The picking is pure (pickRecordingDefaults, classifyGpu) so it can be tested;
 * detectHardware is the only part that touches Electron and the OS.
 */
import { app } from 'electron'
import os from 'os'
import { promises as fsPromises } from 'fs'
import type { HardwareProfile, RecordingDefaults } from '../constants/types'

export type { HardwareProfile, RecordingDefaults }

export type HardwareInfo = {
  /** Logical CPU threads. */
  threads: number
  /** Total memory, GB (1024^3). */
  ramGB: number
  /** Short name of the best graphics found, e.g. "NVIDIA GeForce RTX 3060". */
  gpu: string
  /** True when no discrete GPU was found (Intel graphics / AMD APU only). */
  integrated: boolean
  /** Free space where clips are written, GB; null when unknown. */
  freeDiskGB: number | null
}

type GpuDevice = {
  vendorId?: number
  deviceId?: number
  active?: boolean
  vendorString?: string
  deviceString?: string
  driverVendor?: string
}

const VENDOR_INTEL = 0x8086
const VENDOR_AMD = 0x1002
const VENDOR_NVIDIA = 0x10de
const VENDOR_APPLE = 0x106b

const VENDOR_NAMES: Record<number, string> = {
  [VENDOR_INTEL]: 'Intel',
  [VENDOR_AMD]: 'AMD',
  [VENDOR_NVIDIA]: 'NVIDIA',
  [VENDOR_APPLE]: 'Apple',
}

/** Is this one device integrated graphics (shares the CPU's memory)? */
export function isIntegratedDevice(d: GpuDevice): boolean {
  const vendor = d.vendorId ?? 0
  const name = `${d.vendorString ?? ''} ${d.deviceString ?? ''}`
  if (vendor === VENDOR_NVIDIA || /nvidia|geforce|quadro/i.test(name))
    return false
  if (vendor === VENDOR_INTEL || /intel/i.test(name)) {
    // Intel Arc desktop/laptop cards (A310…A770, B580) are discrete; the Arc
    // graphics inside Core Ultra chips are not ("Intel(R) Arc(TM) Graphics").
    if (/arc(\(tm\))?\s*(pro\s*)?[ab]\d{3}/i.test(name)) return false
    const id = d.deviceId ?? 0
    if (id >= 0x5690 && id <= 0x56ff) return false // Arc A-series (DG2)
    if (id >= 0xe200 && id <= 0xe2ff) return false // Arc B-series (BMG)
    return true
  }
  if (vendor === VENDOR_AMD || /amd|radeon|ati\b/i.test(name)) {
    // Radeon RX / Pro cards are discrete; APUs report "Radeon(TM) Graphics",
    // "Radeon Vega 8 Graphics", "Radeon 780M" and the like.
    if (/\brx\s*\d|radeon\s*pro|radeon\s*r[579]\b|firepro/i.test(name))
      return false
    if (/graphics|vega\s*\d+|\b\d{3}m\b/i.test(name)) return true
    // A bare AMD device with no name: can't tell; count it as discrete.
    return false
  }
  // Apple silicon shares memory but is fast; software renderers and unknown
  // vendors are judged by threads and memory alone.
  return false
}

function deviceName(d: GpuDevice): string {
  const vendor =
    d.vendorString || VENDOR_NAMES[d.vendorId ?? -1] || d.driverVendor || ''
  const device = d.deviceString || ''
  if (device && vendor && device.toLowerCase().includes(vendor.toLowerCase()))
    return device
  return [vendor, device].filter(Boolean).join(' ') || 'Unknown graphics'
}

/**
 * Electron's basic GPU info → the best device's name and whether all we have is
 * integrated graphics. A laptop with Intel + NVIDIA counts as discrete.
 */
export function classifyGpu(info: unknown): {
  gpu: string
  integrated: boolean
} {
  const devices: GpuDevice[] = Array.isArray(
    (info as { gpuDevice?: unknown })?.gpuDevice,
  )
    ? ((info as { gpuDevice: GpuDevice[] }).gpuDevice as GpuDevice[])
    : []
  const real = devices.filter(
    (d) => (d.vendorId ?? 0) !== 0 || d.vendorString || d.deviceString,
  )
  if (real.length === 0) return { gpu: 'Unknown graphics', integrated: false }
  const discrete = real.find((d) => !isIntegratedDevice(d))
  if (discrete) return { gpu: deviceName(discrete), integrated: false }
  const active = real.find((d) => d.active) ?? real[0]
  return { gpu: deviceName(active), integrated: true }
}

/** A computer that should start on light settings. */
export function isWeakHardware(hw: {
  threads: number
  ramGB: number
  integrated: boolean
}): boolean {
  return hw.threads <= 8 || hw.ramGB <= 8 || hw.integrated
}

/**
 * Recording settings for this computer. Each recording Dolphin wants ~4 CPU
 * threads (emulation, GPU thread, dump encoding, ffmpeg) and ~1.5 GB of memory
 * on top of ~4 GB for the system and Clipper; integrated graphics share one GPU
 * between every Dolphin, so they get one.
 */
export function pickRecordingDefaults(hw: {
  threads: number
  ramGB: number
  integrated: boolean
}): RecordingDefaults {
  const weak = isWeakHardware(hw)
  const byThreads = Math.floor(hw.threads / 4)
  const byRam = Math.floor((hw.ramGB - 4) / 1.5)
  const byGpu = hw.integrated ? 1 : 3
  return {
    numCPUs: Math.max(1, Math.min(byThreads, byRam, byGpu)),
    resolution: weak ? 2 : 4,
    videoPreset: weak ? 'veryfast' : 'medium',
    videoQualityMode: 'crf',
    crf: weak ? 20 : 18,
    playbackResolution: 2,
  }
}

/** Free space at `dir` (or its nearest existing parent), GB; null if unknown. */
export async function freeDiskGB(
  dir: string,
  timeoutMs = 1500,
): Promise<number | null> {
  if (!dir) return null
  // statfs is in Electron's Node (18.15+), not in this project's Node types.
  const statfs = (
    fsPromises as unknown as {
      statfs?: (_p: string) => Promise<{ bavail: number; bsize: number }>
    }
  ).statfs
  if (!statfs) return null
  let target = dir
  // The output folder may not exist yet: measure the drive it would be on.
  for (let i = 0; i < 32; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await fsPromises
      .stat(target)
      .then(() => true)
      .catch(() => false)
    if (exists) break
    const parent = target.replace(/[\\/]+[^\\/]*[\\/]*$/, '')
    if (!parent || parent === target) return null
    target = parent
  }
  // A network or sleeping drive can take a long time to answer; don't wait.
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs).unref?.()
  })
  try {
    const st = await Promise.race([statfs(target), timeout])
    if (!st) return null
    return Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10
  } catch {
    return null
  }
}

export function cpuThreads(): number {
  const o = os as unknown as { availableParallelism?: () => number }
  const n =
    typeof o.availableParallelism === 'function'
      ? o.availableParallelism()
      : os.cpus().length
  return Number.isFinite(n) && n > 0 ? n : 2
}

export function totalRamGB(): number {
  return Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
}

/** Threads and memory only, no waiting (graphics are unknown: not integrated). */
export function detectHardwareSync(): HardwareInfo {
  return {
    threads: cpuThreads(),
    ramGB: totalRamGB(),
    gpu: 'Unknown graphics',
    integrated: false,
    freeDiskGB: null,
  }
}

/**
 * Everything pickRecordingDefaults needs, plus free disk at `outputPath`.
 * Graphics come from Electron (app.getGPUInfo('basic')).
 */
export async function detectHardware(outputPath = ''): Promise<HardwareInfo> {
  const base = detectHardwareSync()
  let gpu = base.gpu
  let integrated = base.integrated
  try {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 3000).unref?.()
    })
    const info = await Promise.race([app.getGPUInfo('basic'), timeout])
    if (info) ({ gpu, integrated } = classifyGpu(info))
  } catch {
    // no GPU info (headless, or the GPU process failed): judge by CPU/RAM
  }
  return {
    ...base,
    gpu,
    integrated,
    freeDiskGB: await freeDiskGB(outputPath),
  }
}

/** The summary kept in config (hardwareProfile), with what we picked. */
export function hardwareProfileOf(hw: HardwareInfo): HardwareProfile {
  return {
    threads: hw.threads,
    ramGB: hw.ramGB,
    gpu: hw.gpu,
    integrated: hw.integrated,
    freeDiskGB: hw.freeDiskGB,
    detectedAt: new Date().toISOString(),
    picked: pickRecordingDefaults(hw),
  }
}
