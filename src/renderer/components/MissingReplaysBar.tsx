import { useEffect, useState } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import { showNotice } from 'renderer/importNotice'
import type { MissingReport } from '../../main/missingReplays'
import '../styles/MissingReplaysBar.css'

const n = (v: number) => v.toLocaleString()

/**
 * One quiet warning when the open project's replays aren't on disk any more
 * (docs/library-workspaces.md, Part D). The main process checks on open and
 * repoints what it can find by itself; this offers the rest.
 */
export default function MissingReplaysBar({
  archivePath,
}: {
  archivePath?: string
}) {
  const [report, setReport] = useState<MissingReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    setReport(null)
    setDismissed(false)
    if (!archivePath) return undefined
    ipcBridge.getMissingReplays((r) => setReport(r ?? null))
    return window.electron.ipcRenderer.on(
      'missingReplays',
      (r: MissingReport | null) => {
        setReport(r)
        setDismissed(false)
        if (r?.repointed)
          showNotice(
            `Found ${n(r.repointed)} replays in a new place and updated the project.`,
          )
      },
    )
  }, [archivePath])

  if (!report || report.projectPath !== archivePath || !report.missing)
    return null
  if (dismissed) return null

  const act = (action: 'locate' | 'download' | 'remove') => {
    setBusy(action)
    ipcBridge.missingReplaysAction(action, (res) => {
      setBusy(null)
      if (!res || res.cancelled) return
      if (res.error) showNotice(res.error)
      else if (action === 'locate')
        showNotice(
          res.found
            ? `Found ${n(res.found)} of the missing replays.`
            : 'None of the missing replays are in that folder.',
        )
      else if (action === 'download')
        showNotice(
          `Downloading ${n(res.started)} replays again. Follow it in Lunar Database › Downloads.`,
        )
      else if (action === 'remove')
        showNotice(
          `Removed ${n(res.removed)} missing replays from the project.`,
        )
    })
  }

  const folder = report.folders[0]
  const mostlyOneFolder = folder && folder.count >= report.missing * 0.5
  const message = mostlyOneFolder
    ? `Folder not found: ${folder.folder} (${n(folder.count)} replays${
        report.missing > folder.count
          ? `, ${n(report.missing - folder.count)} more elsewhere`
          : ''
      }). Reconnect the drive, or locate them.`
    : `${n(report.missing)} ${
        report.missing === 1
          ? 'replay in this project is'
          : 'replays in this project are'
      } missing from disk (moved or deleted).`

  return (
    <div className="missing-bar" role="status">
      <span className="missing-bar-text" title={folder?.folder}>
        {message}
      </span>
      <button
        type="button"
        className="missing-bar-btn"
        disabled={!!busy}
        onClick={() => act('locate')}
      >
        {busy === 'locate' ? 'Looking…' : 'Locate…'}
      </button>
      {report.downloadable.length > 0 && (
        <button
          type="button"
          className="missing-bar-btn"
          disabled={!!busy}
          onClick={() => act('download')}
        >
          Download again ({n(report.downloadable.length)})
        </button>
      )}
      {/* Never the first thing offered: an unplugged drive isn't a reason to
          empty the project. */}
      <button
        type="button"
        className="missing-bar-link"
        disabled={!!busy}
        onClick={() => act('remove')}
      >
        Remove from project
      </button>
      <button
        type="button"
        className="missing-bar-close"
        aria-label="Hide"
        title="Hide until the project is opened again"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  )
}
