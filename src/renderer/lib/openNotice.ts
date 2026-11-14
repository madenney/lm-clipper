/**
 * What to tell the user when opening, importing or creating a project fails. A reply of
 * null/undefined is a cancelled dialog (say nothing); `{ error }` is a failure that used to
 * leave the button looking dead (Import, Open recent, drag and drop, Add replays, the menus).
 */

/** The reply's error text: main sends `{ error: 'text' }`, or `{ error: true, info: Error }`. */
function errorText(result: { error?: unknown; info?: unknown }): string {
  const { error, info } = result
  if (typeof error === 'string' && error) return error
  if (info && typeof info === 'object' && 'message' in info)
    return String((info as { message: unknown }).message || '')
  if (typeof info === 'string') return info
  return ''
}

export type OpenKind = 'import' | 'open' | 'new' | 'saveAs'

const WHAT: Record<OpenKind, string> = {
  import: "Couldn't add those replays",
  open: "Couldn't open that project",
  new: "Couldn't create the project",
  saveAs: "Couldn't save the project there",
}

/** A plain sentence for a failed reply, or null when there is nothing to say. */
export function openFailureNotice(
  kind: OpenKind,
  result: unknown,
): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { error?: unknown; info?: unknown }
  if (!r.error) return null
  const text = errorText(r)
  if (text === 'Project file not found')
    return 'That project is no longer where it was (moved, deleted, or on a drive that is not connected), so it was removed from the Recent list.'
  if (text === 'Failed to create project')
    return "Couldn't start a project for these replays. Check that the disk has free space and that Clipper can write to your Documents folder, then try again."
  if (text === 'archive undefined')
    return "Couldn't open a project to add them to. Try again, or start one with File > New Project first."
  if (/^Request timed out/.test(text))
    return 'Clipper took too long to answer. Try again in a moment.'
  return text
    ? `${WHAT[kind]}: ${text}`
    : `${WHAT[kind]}. See the console for details.`
}
