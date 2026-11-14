import { useEffect, useState } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import useIpcListener from '../hooks/useIpcListener'
import type { Transfer } from '../../constants/database'
import DatabasePanel, { DatabaseTab } from './DatabasePanel'
import type { ClipSearchFilters } from '../../constants/clipSearch'
import { OPEN_DATABASE_EVENT, OpenDatabaseDetail } from '../lib/openDatabase'

/**
 * Hosts the Lunar Database panel at the app root, so it opens from anywhere:
 * the top bar, Getting Started, Settings, with or without a project open
 * (Find moments adds to My Replays then). Buttons call openLunarDatabase(tab).
 */
export default function DatabaseDock() {
  const [tab, setTab] = useState<DatabaseTab | null>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  // A search Find clips should open on, and a key so it starts fresh.
  const [clipSearch, setClipSearch] = useState<{
    filters: ClipSearchFilters
    key: number
  } | null>(null)
  useIpcListener('databaseTransfers', (jobs: Transfer[]) => {
    if (Array.isArray(jobs)) setTransfers(jobs)
  })
  // Main opens it too (File › Extract Replays… shows its progress here).
  useIpcListener('openLunarDatabase', (requested: DatabaseTab) => {
    if (['search', 'clips', 'transfers'].includes(requested)) setTab(requested)
  })
  useEffect(() => {
    ipcBridge.database({ action: 'list' }, (response) => {
      if (response.transfers) setTransfers(response.transfers)
    })
    const open = (event: Event) => {
      event.preventDefault()
      const requested = (event as CustomEvent<OpenDatabaseDetail | undefined>)
        .detail
      if (requested?.clipSearch)
        setClipSearch({ filters: requested.clipSearch, key: Date.now() })
      setTab(requested?.tab ?? 'search')
    }
    window.addEventListener(OPEN_DATABASE_EVENT, open)
    return () => window.removeEventListener(OPEN_DATABASE_EVENT, open)
  }, [])
  return (
    <DatabasePanel
      tab={tab}
      onTab={setTab}
      transfers={transfers}
      onTransfers={setTransfers}
      clipSearch={clipSearch}
    />
  )
}
