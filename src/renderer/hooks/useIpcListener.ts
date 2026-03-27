import { useEffect } from 'react'

/**
 * Subscribe to an IPC channel on mount, automatically unsubscribe on unmount.
 * Prevents listener leaks when components remount.
 *
 * @param channel - IPC channel name to listen on
 * @param handler - Callback invoked with the message data
 * @param deps - Additional dependencies that should trigger re-subscription
 */
export default function useIpcListener(
  channel: string,
  handler: (..._args: any[]) => void,
  deps: any[] = [],
) {
  useEffect(() => {
    const remove = window.electron.ipcRenderer.on(channel, handler)
    return () => {
      remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, ...deps])
}
