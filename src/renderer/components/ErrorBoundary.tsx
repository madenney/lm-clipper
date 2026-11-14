import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** What this boundary guards, for the log ("workspace", "downloads panel"...). */
  area: string
  /** 'page': the whole window shows the fallback. 'inline': a small box where the part was
   *  (the rest of the app keeps working). */
  fallback?: 'page' | 'inline'
  /** Close the open project: the way out when the same project crashes every time it opens. */
  onCloseProject?: () => void
  /** Open the folder with Clipper's logs. */
  onOpenLogs?: () => void
}

type State = { error: Error | null }

const send = (payload: Record<string, unknown>) => {
  try {
    window.electron?.ipcRenderer?.sendMessage('rendererError', payload)
  } catch {
    // no bridge (a test): nothing to log to
  }
}

/**
 * A render crash used to blank the window (only the workspace was guarded) and say nothing in the
 * log. Now each guarded part reports the error to main.log and offers a way out: Reload, and for
 * the workspace "Close project", since the last project reopens at launch and a bad row in it
 * would crash every start.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const { area } = this.props
    console.error(`[ErrorBoundary:${area}]`, error, info.componentStack)
    send({
      type: 'react-error',
      area,
      message: error?.message,
      stack: error?.stack,
      componentStack: info.componentStack,
    })
  }

  render() {
    const { error } = this.state
    const {
      children,
      fallback = 'page',
      onCloseProject,
      onOpenLogs,
      area,
    } = this.props
    if (!error) return children
    const retry = () => this.setState({ error: null })
    if (fallback === 'inline') {
      return (
        <div
          role="alert"
          style={{
            position: 'fixed',
            right: 12,
            bottom: 12,
            zIndex: 6000,
            maxWidth: 360,
            padding: '8px 12px',
            borderRadius: 6,
            background: '#2a1a1a',
            border: '1px solid #6b2b2b',
            color: '#e6c7c7',
            fontSize: 13,
          }}
        >
          Something went wrong in the {area}.{' '}
          <button
            type="button"
            onClick={retry}
            style={{ cursor: 'pointer', marginLeft: 6 }}
          >
            Try again
          </button>
        </div>
      )
    }
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 12,
          padding: 24,
          textAlign: 'center',
          color: '#ccc',
        }}
      >
        <p style={{ margin: 0, fontSize: 16 }}>Something went wrong.</p>
        <p style={{ margin: 0, maxWidth: 460, fontSize: 13, color: '#a8a8a8' }}>
          The error was written to Clipper&apos;s log. If it happens again when
          this project opens, close the project and open it again (or another
          one).
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '6px 16px', cursor: 'pointer' }}
          >
            Reload
          </button>
          {onCloseProject && (
            <button
              type="button"
              onClick={() => {
                onCloseProject()
                retry()
              }}
              style={{ padding: '6px 16px', cursor: 'pointer' }}
            >
              Close project
            </button>
          )}
          {onOpenLogs && (
            <button
              type="button"
              onClick={onOpenLogs}
              style={{ padding: '6px 16px', cursor: 'pointer' }}
            >
              Open log folder
            </button>
          )}
        </div>
      </div>
    )
  }
}
