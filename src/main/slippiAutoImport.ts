/**
 * Auto-import: new games in the Slippi folder go into the open project by themselves
 * (Settings > Project > "Import new Slippi games automatically", config.autoImportSlippi).
 *
 * The folder is looked at every few seconds (a timer, not file-change events: those differ on
 * each platform and miss network drives). Only finished games are taken: Slippi writes a .slp
 * while the game is played and fills in the header's data length when it ends, so a 0 there
 * means "still being played". Only games newer than `autoImportSlippiSince` count (set when
 * the setting is turned on, moved on as games are imported), so turning it on does not pull
 * in the whole back catalogue, and games played while Clipper was closed come in at the next
 * launch. Import itself is the ordinary one (ImportManager.enqueueImport), which already
 * skips files the project has.
 */
import fs from 'fs'
import path from 'path'

/** `{U\x03raw[$U#l`: the start of every .slp, followed by the raw data length (int32, big-endian). */
const SLP_HEADER = Buffer.from('{U\x03raw[$U#l', 'latin1')

/** Slippi has finished writing this .slp: its raw data length is filled in (0 while the game is played). */
export function isFinishedSlp(file: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(SLP_HEADER.length + 4)
    if (fs.readSync(fd, b, 0, b.length, 0) < b.length) return false
    if (!b.subarray(0, SLP_HEADER.length).equals(SLP_HEADER)) return false
    return b.readInt32BE(SLP_HEADER.length) > 0
  } catch {
    return false
  } finally {
    if (fd !== null)
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
  }
}

/** What one scan remembers for the next: files already taken or passed over, by path. */
export type ScanState = { done: Set<string> }

export const newScanState = (): ScanState => ({ done: new Set() })

/** A game still unfinished after this long is taken anyway (a crash can leave the length at 0). */
export const ABANDONED_MS = 10 * 60_000
/** Written to this recently: leave it for the next look. */
const SETTLE_MS = 1500

/**
 * The finished .slp files in `dir` and its subfolders (one level: Slippi's monthly folders)
 * newer than `since` (ms) and not seen before. `waitingSince` is the oldest game still being
 * played, so the caller does not move `since` past it.
 */
export function findNewReplays(
  dir: string,
  since: number,
  state: ScanState,
  now = Date.now(),
): { ready: { file: string; mtimeMs: number }[]; waitingSince: number | null } {
  const ready: { file: string; mtimeMs: number }[] = []
  let waitingSince: number | null = null
  const look = (folder: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(folder, e.name)
      if (e.isDirectory()) {
        if (depth > 0) continue
        // A folder nothing was added to since `since` holds nothing new.
        try {
          if (fs.statSync(p).mtimeMs <= since) continue
        } catch {
          continue
        }
        look(p, depth + 1)
        continue
      }
      if (!e.isFile() || path.extname(e.name).toLowerCase() !== '.slp') continue
      if (state.done.has(p)) continue
      let mtimeMs: number
      try {
        mtimeMs = fs.statSync(p).mtimeMs
      } catch {
        continue
      }
      if (mtimeMs <= since) {
        state.done.add(p)
        continue
      }
      const age = now - mtimeMs
      if (age < SETTLE_MS || (!isFinishedSlp(p) && age < ABANDONED_MS)) {
        waitingSince =
          waitingSince === null ? mtimeMs : Math.min(waitingSince, mtimeMs)
        continue
      }
      state.done.add(p)
      ready.push({ file: p, mtimeMs })
    }
  }
  look(dir, 0)
  ready.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return { ready, waitingSince }
}

/** Where `since` goes after a scan: past what was taken, never past a game still being played. */
export function nextSince(
  since: number,
  ready: { mtimeMs: number }[],
  waitingSince: number | null,
): number {
  let next = since
  for (const r of ready) next = Math.max(next, r.mtimeMs)
  if (waitingSince !== null) next = Math.min(next, waitingSince - 1)
  return Math.max(since, next)
}

export type AutoImportHost = {
  getConfig: () => {
    autoImportSlippi?: boolean
    autoImportSlippiSince?: number | null
  }
  saveConfig: () => void
  /** The open project, or null (nothing is imported then). */
  projectPath: () => string | null
  slippiDir: () => string | null
  importFiles: (_files: string[]) => void
  log: (_message: string) => void
}

export const AUTO_IMPORT_INTERVAL_MS = 5000

export class SlippiAutoImport {
  private timer: ReturnType<typeof setInterval> | null = null
  private state = newScanState()
  private project: string | null = null

  private host: AutoImportHost

  constructor(host: AutoImportHost) {
    this.host = host
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), AUTO_IMPORT_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One look. Public for tests. */
  tick(now = Date.now()): string[] {
    const config = this.host.getConfig()
    if (!config.autoImportSlippi) {
      // Off: forget the mark, so turning it on again starts from then.
      if (config.autoImportSlippiSince != null) {
        config.autoImportSlippiSince = null
        this.host.saveConfig()
      }
      this.state = newScanState()
      return []
    }
    if (config.autoImportSlippiSince == null) {
      config.autoImportSlippiSince = now
      this.host.saveConfig()
      return []
    }
    const project = this.host.projectPath()
    if (!project) return []
    // Another project: start over (what was seen was for the last one).
    if (project !== this.project) {
      this.project = project
      this.state = newScanState()
    }
    const dir = this.host.slippiDir()
    if (!dir) return []
    const since = config.autoImportSlippiSince
    const { ready, waitingSince } = findNewReplays(dir, since, this.state, now)
    const next = nextSince(since, ready, waitingSince)
    if (next !== since) {
      config.autoImportSlippiSince = next
      this.host.saveConfig()
    }
    if (!ready.length) return []
    const files = ready.map((r) => r.file)
    this.host.log(
      `Auto-import: ${files.length} new ${files.length === 1 ? 'game' : 'games'} from your Slippi folder`,
    )
    this.host.importFiles(files)
    return files
  }
}
