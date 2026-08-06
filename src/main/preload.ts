// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import {
  contextBridge,
  ipcRenderer,
  IpcRendererEvent,
  webUtils,
} from 'electron'

const SEND_CHANNELS = new Set([
  'getConfig',
  'updateConfig',
  'setDefaultOutputPath',
  'getArchive',
  'getImportStatus',
  'getDirectory',
  'createNewArchive',
  'openExistingArchive',
  'newProject',
  'saveAsArchive',
  'getRecentProjects',
  'openRecentProject',
  'addFilesManual',
  'addDroppedFiles',
  'cancelImport',
  'stopImport',
  'closeArchive',
  'addFilter',
  'updateFilter',
  'reorderFilter',
  'removeFilter',
  'saveCustomFilter',
  'deleteCustomFilter',
  'getResults',
  'getAllResultIds',
  'getTableDuration',
  'getFilterCount',
  'getNames',
  'getConnectCodes',
  'runFilter',
  'resumeFilter',
  'dismissFilterResume',
  'runFilters',
  'cancelRunningFilters',
  'stopRunningFilters',
  'stopFilter',
  'cancelFilter',
  'getPath',
  'detectDolphinPath',
  'detectIsoPath',
  'detectSlippiReplays',
  'validateDolphinPath',
  'validateIsoPath',
  'openDolphinFolder',
  'generateVideo',
  'stopVideo',
  'cancelVideo',
  'checkStitchable',
  'stitchClips',
  'playClips',
  'playClip',
  'stopPlayback',
  'recordClip',
  'removeGame',
  'removeResult',
  'reorderClips',
  'logPerfEvents',
  'debugLog',
  'testDolphin',
  'openCodeEditor',
  'openCodeEditorForTemplate',
  'openFolder',
  'openExternal',
  'getLogsPath',
  'exportLogs',
  'getAppVersion',
  'resetConfig',
  'resetApp',
  'rendererError',
  'slpzWizardResponse',
  'zipWizardResponse',
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
