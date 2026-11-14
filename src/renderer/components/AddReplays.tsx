import { useEffect, useState } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import { showNotice } from '../importNotice'
import { openFailureNotice } from '../lib/openNotice'
import { useModal } from '../hooks/useModal'
import { useArchive } from '../context/AppContext'
import { openLunarDatabase } from '../lib/openDatabase'
import useIpcListener from '../hooks/useIpcListener'
import type { Transfer } from '../../constants/database'
import '../styles/AddReplays.css'

const incomingLabels: Partial<Record<Transfer['stage'], string>> = {
  queued: 'Waiting to start',
  preparing: 'Being packed on the Lunar Database',
  downloading: 'Downloading',
  extracting: 'Unpacking',
  importing: 'Adding to your project',
  paused: 'Paused',
  failed: 'Needs attention',
}

/**
 * Games on their way into this project (Find replays), shown where its replays
 * will appear so an empty project never looks stuck.
 */
export function IncomingReplays() {
  const { archive } = useArchive()
  const [transfers, setTransfers] = useState<Transfer[]>([])
  useIpcListener('databaseTransfers', (jobs: Transfer[]) => {
    if (Array.isArray(jobs)) setTransfers(jobs)
  })
  useEffect(() => {
    ipcBridge.database({ action: 'list' }, (response: any) => {
      if (Array.isArray(response?.transfers)) setTransfers(response.transfers)
    })
  }, [])
  const job = transfers.find(
    (t) =>
      t.kind === 'database' &&
      t.projectPath === archive?.path &&
      t.stage !== 'completed' &&
      t.stage !== 'waiting-project',
  )
  if (!job) return null
  const stuck = job.stage === 'failed' || job.stage === 'paused'
  const busy = ['preparing', 'downloading', 'extracting', 'importing'].includes(
    job.stage,
  )
  return (
    <div className={`incoming-replays${stuck ? ' incoming-stuck' : ''}`}>
      <h4>
        {stuck ? 'Your games stopped on the way' : 'Your games are on the way'}
      </h4>
      <p className="incoming-stage">
        {incomingLabels[job.stage] ?? job.stage}
        {job.detail ? ` · ${job.detail}` : ''}
      </p>
      {busy && (
        <progress
          aria-label="Download progress"
          value={job.total ? Math.min(job.current, job.total) : undefined}
          max={job.total || 1}
        />
      )}
      <p className="incoming-note">
        {stuck
          ? 'Open Downloads to resume or retry.'
          : 'They appear here when they’re in. Keep working, or close this: the download carries on.'}
      </p>
      <button
        type="button"
        className="add-link"
        onClick={() => openLunarDatabase('transfers')}
      >
        See downloads
      </button>
    </div>
  )
}

/**
 * Add replays: the two places replays come from, side by side (APP_FLOW.md,
 * "Add replays"). This PC: your Slippi folder, chosen files, dropped files,
 * archives to unpack. Lunar Database: clips or whole games, downloaded once
 * into the Replay Library. Either way they end up as ordinary project files.
 */
export default function AddReplays({ onDone }: { onDone?: () => void }) {
  const { setArchive } = useArchive()
  const [slippi, setSlippi] = useState<{ dir: string; count: number } | null>(
    null,
  )

  useEffect(() => {
    ipcBridge.detectSlippiReplays((res) =>
      setSlippi(res && res.count > 0 ? res : null),
    )
  }, [])

  const imported = (result: any) => {
    // A failure says why (it used to do nothing); a cancelled dialog replies null: silent.
    const failed = openFailureNotice('import', result)
    if (failed) showNotice(failed)
    else if (result && !result.error) setArchive(result)
  }
  const local = (run: () => void) => () => {
    run()
    onDone?.()
  }
  const database = (tab: 'clips' | 'search') => () => {
    openLunarDatabase(tab)
    onDone?.()
  }
  const count = slippi
    ? `${slippi.count.toLocaleString()}${slippi.count >= 50000 ? '+' : ''}`
    : ''

  return (
    <div className="add-replays">
      <section className="add-source">
        <h4>From this PC</h4>
        {slippi ? (
          <>
            <p title={slippi.dir}>{count} replays in your Slippi folder.</p>
            <button
              type="button"
              className="add-primary"
              onClick={local(() =>
                ipcBridge.importDroppedSlpFiles([slippi.dir], imported),
              )}
            >
              Import them
            </button>
          </>
        ) : (
          <>
            <p>Your own .slp replays, or a folder of them.</p>
            <button
              type="button"
              className="add-primary"
              onClick={local(() => ipcBridge.importSlpFiles(imported))}
            >
              Choose replays…
            </button>
          </>
        )}
        <div className="add-quiet">
          {slippi && (
            <>
              <button
                type="button"
                className="add-link"
                onClick={local(() => ipcBridge.importSlpFiles(imported))}
              >
                choose other replays
              </button>
              {' · '}
            </>
          )}
          <button
            type="button"
            className="add-link"
            title="Unpack ZIP or SLPZ archives into playable replays"
            onClick={local(() => ipcBridge.extractReplays('files'))}
          >
            unpack ZIP / SLPZ…
          </button>
        </div>
        <div className="add-quiet">
          or drag files or a folder onto the window
        </div>
      </section>
      <section className="add-source">
        <h4>From Lunar Database</h4>
        <p>Millions of replays available for download.</p>
        <button
          type="button"
          className="add-primary"
          onClick={database('search')}
        >
          Download games
        </button>
        <div className="add-quiet">
          or{' '}
          <button
            type="button"
            className="add-link"
            onClick={database('clips')}
          >
            search pre-parsed moments
          </button>{' '}
          (combos, kills…)
        </div>
        <div className="add-quiet">
          Each game is downloaded once, into your Replay Library.
        </div>
      </section>
    </div>
  )
}

/** "+ Add replays" in a project: the same two sources in a small dialog. */
export function AddReplaysDialog({ onClose }: { onClose: () => void }) {
  const box = useModal({ onEscape: onClose })
  return (
    // A click on the dimmed backdrop (not the dialog) closes it; Esc too.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="add-replays-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={box}
        className="add-replays-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add replays"
      >
        <header>
          <h3>Add replays</h3>
          <button type="button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <AddReplays onDone={onClose} />
      </div>
    </div>
  )
}
