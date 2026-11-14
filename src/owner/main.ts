// Owner-only extension point, empty in this build.
import type { IpcMain } from 'electron'
import type { ArchiveInterface, ConfigInterface } from '../constants/types'

export type OwnerDeps = {
  getConfig: () => ConfigInterface
  saveConfig: () => void
  getArchive: () => ArchiveInterface | null
  /** Open this project in the window (as from the recent-projects menu). */
  openProject: (_projectPath: string) => void
  /** Close this project if it is the open one. */
  releaseProject: (_projectPath: string) => Promise<void>
}

export function startOwnerTools(_ipcMain: IpcMain, _deps: OwnerDeps): void {}

/** Files Clipper's cleanup must leave alone: none in this build. */
export function ownerKeptPaths(_config: ConfigInterface): string[] {
  return []
}
