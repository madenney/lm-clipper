import { useCallback, useEffect, useRef, useState } from 'react'
import '../styles/Filters.css'
import '../styles/AppDialog.css'

/** A question from the main process (src/main/askRenderer.ts). */
export interface AppDialogRequest {
  id: string
  type: 'none' | 'info' | 'question' | 'warning' | 'error'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId: number
  cancelId: number
  checkboxLabel?: string
  checkboxChecked: boolean
}

const severity = (type: AppDialogRequest['type']) => {
  if (type === 'error') return 'filter-warn-high'
  if (type === 'warning') return 'filter-warn-medium'
  return 'filter-warn-low'
}

export function AppDialog({
  request,
  onAnswer,
}: {
  request: AppDialogRequest
  onAnswer: (_response: number, _checked: boolean) => void
}) {
  const [checked, setChecked] = useState(request.checkboxChecked)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAnswer(request.cancelId, checked)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request.cancelId, checked, onAnswer])
  return (
    <div className="filter-warn-overlay app-dialog-overlay" role="presentation">
      <div
        className={`filter-warn-modal app-dialog ${severity(request.type)}`}
        role={request.type === 'error' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={request.title || request.message}
      >
        {request.title && (
          <div className="app-dialog-eyebrow">{request.title}</div>
        )}
        <div className="filter-warn-title">{request.message}</div>
        {request.detail && (
          <div className="filter-warn-body app-dialog-detail">
            {request.detail}
          </div>
        )}
        {request.checkboxLabel && (
          <label className="filter-warn-checkbox">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            {request.checkboxLabel}
          </label>
        )}
        <div className="filter-warn-actions app-dialog-actions">
          {request.buttons.map((label, i) => (
            <button
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              type="button"
              className={`filter-warn-btn${i === request.defaultId ? ' app-dialog-default' : ''}`}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={i === request.defaultId}
              onClick={() => onAnswer(i, checked)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Shows the dialogs main asks for (what used to be Windows/GTK message boxes)
 * in the app's own style, one at a time in the order asked. Mounted once at the
 * root; it tells main it is listening, so a question asked at startup waits
 * for it.
 */
export default function AppDialogHost() {
  const [queue, setQueue] = useState<AppDialogRequest[]>([])
  const seen = useRef(new Set<string>())
  const current = queue[0]

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return undefined
    const off = ipc.on('askDialog', (request: AppDialogRequest) => {
      if (!request?.id || seen.current.has(request.id)) return
      seen.current.add(request.id)
      setQueue((q) => [...q, request])
    })
    ipc.sendMessage('dialogReady', null)
    return off
  }, [])

  const answer = useCallback(
    (request: AppDialogRequest, response: number, checked: boolean) => {
      window.electron?.ipcRenderer.sendMessage('dialogReply', {
        id: request.id,
        response,
        checkboxChecked: checked,
      })
      setQueue((q) => q.filter((r) => r.id !== request.id))
    },
    [],
  )

  if (!current) return null
  return (
    <AppDialog
      key={current.id}
      request={current}
      onAnswer={(response, checked) => answer(current, response, checked)}
    />
  )
}
