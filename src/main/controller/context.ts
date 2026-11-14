import type { BrowserWindow } from 'electron'
import type { Worker } from 'worker_threads'
import type { getMetaData } from '../dbAsync'
import type { ArchiveInterface, ConfigInterface } from '../../constants/types'
import type CpuScanControl from '../cpuScanControl'
import type { LastFrameScanCounts } from '../../lib/lastFrame'
import type { MissingReport } from '../missingReplays'
import type ImportManager from '../managers/ImportManager'
import type FilterExecutor from '../managers/FilterExecutor'
import type VideoManager from '../managers/VideoManager'
import type ClipManager from '../managers/ClipManager'
import type TransferManager from '../managers/TransferManager'

type MetaData = Awaited<ReturnType<typeof getMetaData>>

/**
 * Everything the extracted controller modules (src/main/controller/*.ts) may
 * reach on the Controller. The Controller owns all of this state; each module
 * declares the narrow `Pick<ControllerCore, ...>` it actually uses, and the
 * Controller passes itself as that context.
 */
export interface ControllerCore {
  mainWindow: BrowserWindow
  configPath: string
  devBackupPath: string
  config: ConfigInterface
  archive: ArchiveInterface | null

  importManager: ImportManager
  filterExecutor: FilterExecutor
  videoManager: VideoManager
  clipManager: ClipManager
  transferManager: TransferManager

  hardwareReady: Promise<void>
  rendererReadyFired: boolean
  onRendererReady: (() => void) | null
  compactingPath: string | null
  missingReport: MissingReport | null
  missingWorker: Worker | null
  countWorkerExecArgv?: string[]
  cpuScan: CpuScanControl
  lastFrameScan: CpuScanControl<LastFrameScanCounts>

  saveConfig(): Promise<void>
  library(): { folder: string }
  setArchiveInternal(_a: ArchiveInterface | null): void
  reloadArchiveFrom(_archivePath: string): Promise<MetaData>
  createNewArchiveInternal(_payload: {
    name?: string
    location?: string
  }): Promise<MetaData>
  autoCreateUntitledProject(): Promise<MetaData>
  closeCurrentProject(): Promise<void>
  prepareProjectSwitch(): Promise<boolean>
  updateWindowTitle(): void
  addToRecentProjects(_name: string, _projectPath: string): void
  removeFromRecentProjects(_projectPath: string): void
  getUntitledName(_dir: string, _base?: string): string
  defaultWorkspacePath(): string
  ensureDefaultOutputPath(): void
  pickSettingsForThisComputer(): Promise<void>
  refreshFreeDisk(): Promise<void>
  stopNameCountWorker(): void
  ensureNameCountWorker(): Worker
  startCpuScan(): void
  stopCpuScan(): Promise<void>
  restartIntoConfig(): Promise<void>
}
