import {
  describeTray,
  type TrayFilter,
  type TrayLive,
} from '../../lib/describeTray'
import '../styles/TrayNote.css'

/**
 * One plain sentence under the filters about what the tray shows right now ("Showing 371
 * combos, 4 hits min, sorted by DPS"). It follows the step the tray is on (activeFilterId).
 */
export default function TrayNote({
  filters,
  activeFilterId,
  replayCount,
  live,
}: {
  filters: TrayFilter[]
  activeFilterId: string
  /** The project's replay count (what the tray shows before any step is picked). */
  replayCount: number | null
  /** Steps running now and what they have found so far. */
  live?: TrayLive
}) {
  const d = describeTray(filters, activeFilterId, replayCount, live)
  return (
    <p className="tray-note" aria-live="polite">
      {d.lead}
      {d.focus && (
        <>
          {' '}
          <b>{d.focus}</b>
        </>
      )}
      {d.tail}
    </p>
  )
}
