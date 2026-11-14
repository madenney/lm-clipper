/**
 * Plain text of a thrown value, for showing to the user. `String(err)` on an
 * Error adds "Error: " in front of its message, and some messages already
 * start with "Error: ", which read "Error: Error: Could not open Dolphin…".
 */
export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  let text: string
  if (err instanceof Error) text = err.message
  else if (
    err &&
    typeof err === 'object' &&
    typeof (err as { message?: unknown }).message === 'string'
  )
    text = (err as { message: string }).message
  else if (err === undefined || err === null) text = ''
  else text = String(err)
  text = text.replace(/^(\s*Error:\s*)+/i, '').trim()
  return text || fallback
}

/**
 * The line shown for a failed recording: "Error: <message>", once. A run that
 * stopped itself ("Stopped: disk full on …") is shown as it is.
 */
export function shownError(err: unknown, fallback?: string): string {
  const m = errorMessage(err, fallback)
  return /^Stopped:/.test(m) ? m : `Error: ${m}`
}
