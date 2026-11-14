import { useEffect, useState } from 'react'
import ipcBridge from '../ipcBridge'
import useIpcListener from './useIpcListener'

/**
 * What is running in the open project right now, from main's own messages, for parts of the app
 * that sit outside the workspace (the Lunar Database panel) and must not swap the project under
 * a running filter, import or recording.
 */
export type WorkRunning = {
  filters: boolean
  importing: boolean
  recording: boolean
}

export const noWork: WorkRunning = {
  filters: false,
  importing: false,
  recording: false,
}

/** A short phrase for what is running ("a filter is running"), or null when nothing is. */
export function describeWork(w: WorkRunning): string | null {
  if (w.recording) return 'a recording is running'
  if (w.filters) return 'a filter is running'
  if (w.importing) return 'an import is running'
  return null
}

export default function useWorkRunning(): WorkRunning {
  const [work, setWork] = useState<WorkRunning>(noWork)
  useIpcListener('currentlyRunningFilter', (event: { runningIds?: string[] }) =>
    setWork((w) => ({ ...w, filters: (event?.runningIds?.length ?? 0) > 0 })),
  )
  useIpcListener('importStatus', (status: { isImporting?: boolean }) =>
    setWork((w) => ({ ...w, importing: !!status?.isImporting })),
  )
  useIpcListener('videoMsg', (msg: string) => {
    // The progress lines of a recording (a preview's or a test's notices do not end with a job).
    if (
      typeof msg === 'string' &&
      /^(recording|encoding) \d|^Concatenating|^Configuring Dolphin/.test(msg)
    )
      setWork((w) => (w.recording ? w : { ...w, recording: true }))
  })
  useIpcListener('videoJobFinished', () =>
    setWork((w) => ({ ...w, recording: false })),
  )
  useEffect(() => {
    ipcBridge.getImportStatus((status: { isImporting?: boolean }) =>
      setWork((w) => ({ ...w, importing: !!status?.isImporting })),
    )
  }, [])
  return work
}
