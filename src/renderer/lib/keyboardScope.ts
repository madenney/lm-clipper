/**
 * Whether the window-wide shortcuts (the tray's Delete, Esc, Ctrl+A, Z/X) should leave this key
 * alone: the user is typing, a dialog or a dropdown is open, or the key is meant for something
 * that is not the tray. Without this, Backspace in Settings removed the selected clips.
 */
import { isModalOpen } from '../hooks/useModal'

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
/** Dialogs (also those not opened through useModal) and open dropdown menus. */
const OVERLAYS =
  '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],.char-select-menu,.filter-multi-menu'

export function shortcutsBlocked(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (t && (TYPING.has(t.tagName) || t.isContentEditable)) return true
  if (isModalOpen()) return true
  return document.querySelector(OVERLAYS) !== null
}

/** Delete / Backspace only count when the focus is on the page itself or inside `scope`
 *  (the tray), not on a button elsewhere (a top-bar button, a step card). */
export function deleteKeyTargetsScope(
  e: KeyboardEvent,
  scope: HTMLElement | null,
): boolean {
  const t = e.target as Node | null
  // The page itself (body, the document, the window): not on any one control.
  if (
    !(t instanceof Node) ||
    t === document.body ||
    t === document.documentElement
  )
    return true
  return !!scope && scope.contains(t)
}
