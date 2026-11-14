import { FaStar } from 'react-icons/fa'
import { useModal } from '../hooks/useModal'
import type { ChangelogEntry } from '../../constants/changelog'
import '../styles/WhatsNew.css'

/** Window event asking App.tsx to open the full changelog (Settings > About). */
export const SHOW_CHANGELOG_EVENT = 'lunar:showChangelog'
export const openChangelog = () =>
  window.dispatchEvent(new Event(SHOW_CHANGELOG_EVENT))

/**
 * "What's new". After an update it opens once with what changed since the version the
 * user last saw (`history` false); from Settings > About or Help it lists every release.
 */
export default function WhatsNew({
  entries,
  history,
  onClose,
}: {
  entries: ChangelogEntry[]
  /** Whole history, opened on purpose (not the one-time update popup). */
  history: boolean
  onClose: () => void
}) {
  // Focus in, Tab kept inside, Esc closes, focus back (hooks/useModal.ts).
  const box = useModal({ onEscape: onClose })

  const newest = entries[0]
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="wn-overlay" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={box}
        className="wn-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wn-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wn-header">
          <div className="wn-icon" aria-hidden>
            <FaStar />
          </div>
          <div>
            <h2 id="wn-title">
              {history || !newest
                ? 'What’s new'
                : `What’s new in ${newest.version}`}
            </h2>
            {!history && newest && <p>{newest.summary}</p>}
            {history && <p>Every release, newest first.</p>}
          </div>
        </div>

        <div className="wn-body">
          {entries.map((e) => (
            <section key={e.version} className="wn-release">
              {(history || entries.length > 1) && (
                <h3 className="wn-version">
                  <span>{e.version}</span>
                  <span className="wn-date">{e.date}</span>
                </h3>
              )}
              {(history || entries.length > 1) && (
                <p className="wn-summary">{e.summary}</p>
              )}
              {e.groups.map((g) => (
                <div key={g.heading} className="wn-group">
                  <h4>{g.heading}</h4>
                  <ul>
                    {g.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>

        <div className="wn-footer">
          <button type="button" className="wn-close" onClick={onClose}>
            {history ? 'Close' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  )
}
