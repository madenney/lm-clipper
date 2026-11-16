// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import {
  contextBridge,
  ipcRenderer,
  IpcRendererEvent,
  webUtils,
} from 'electron'
import { OWNER_SEND_CHANNELS } from '../owner/channels'

const SEND_CHANNELS = new Set([
  'databaseRequest',
  ...OWNER_SEND_CHANNELS,
  'getMissingReplays',
  'missingReplaysAction',
  'getCpuScanStatus',
  'cpuScanAction',
  'getLastFrameScanStatus',
  'lastFrameScanAction',
  'moveReplayLibrary',
  'detectorCache',
  'extractReplays',
  'getConfig',
  'updateConfig',
  'setDefaultOutputPath',
  'getArchive',
  'getImportStatus',
  'getDirectory',
  'createNewArchive',
  'openExistingArchive',
  'newProject',
  'openMyReplays',
  'saveAsArchive',
  'getRecentProjects',
  'openRecentProject',
  'addFilesManual',
  'addDroppedFiles',
  'cancelImport',
  'stopImport',
  'closeArchive',
  'addFilter',
  'applyStarterChain',
  'updateFilter',
  'reorderFilter',
  'removeFilter',
  'saveCustomFilter',
  'deleteCustomFilter',
  'getResults',
  'getSelectionDuration',
  'getTableDuration',
  'getFilterCount',
  'getNames',
  'getConnectCodes',
  'runFilter',
  'resumeFilter',
  'dismissFilterResume',
  'keepFilterResults',
  'cancelRunningFilters',
  'stopRunningFilters',
  'stopFilter',
  'cancelFilter',
  'getPath',
  'overlayFontsList',
  'overlayFontsImport',
  'overlayFontsRemove',
  'overlayPreview',
  'detectDolphinPath',
  'detectIsoPath',
  'detectSlippiReplays',
  'validateDolphinPath',
  'validateIsoPath',
  'getClipTrack',
  'readReplayFile',
  'getOverviewChunk',
  'openDolphinFolder',
  'generateVideo',
  'stopVideo',
  'cancelVideo',
  'videoToolsList',
  'videoToolsRun',
  'videoToolsProbe',
  'videoToolsCancel',
  'videoToolsReveal',
  'playClips',
  'playClip',
  'stopPlayback',
  'recordClip',
  'removeGame',
  'removeResult',
  'previewRemoveGames',
  'reorderClips',
  'logPerfEvents',
  'debugLog',
  'testDolphin',
  'openCodeEditor',
  'openCodeEditorForTemplate',
  'openFolder',
  'openExternal',
  'getLogsPath',
  'openLogsFolder',
  'exportLogs',
  'getAppVersion',
  'resetConfig',
  'resetApp',
  'hasDevBackup',
  'restoreDevBackup',
  'rendererError',
  'slpzWizardResponse',
  'zipWizardResponse',
  'approveCustomCodeOnce',
  'code-editor-save',
  'code-editor-save-template',
  'code-editor-delete-template',
  'code-editor-test-run',
  'code-editor-close',
  'code-editor-ready',
  'code-editor-ai-prompt-copied',
  'download-update',
  'install-update',
  'check-for-updates',
  'dialogReady',
  'dialogReply',
])

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: string, args: any) {
      if (!SEND_CHANNELS.has(channel)) {
        console.warn(`[preload] Blocked send to unknown channel: ${channel}`)
        return
      }
      ipcRenderer.send(channel, args)
    },
    on(channel: string, func: (...args: any[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: any[]) =>
        func(...args)
      ipcRenderer.on(channel, subscription)

      return () => {
        ipcRenderer.removeListener(channel, subscription)
      }
    },
    once(channel: string, func: (...args: any[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args))
    },
  },
}

contextBridge.exposeInMainWorld('electron', electronHandler)
contextBridge.exposeInMainWorld('electronPlatform', process.platform)
contextBridge.exposeInMainWorld('electronWebUtils', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})

export type ElectronHandler = typeof electronHandler
