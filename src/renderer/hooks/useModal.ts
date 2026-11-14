import { useEffect, useRef, type RefObject } from 'react'

/**
 * What every dialog needs and a bare overlay div does not give: focus moves into it when it
 * opens and Tab stays inside until it closes, Escape closes only the top one (not the dialog
 * under it, not the tray behind it) and focus returns to where it was. Attach the returned ref
 * to the dialog's own box, with role="dialog", aria-modal="true" and a label:
 *
 *   const box = useModal({ onEscape: onClose })
 *   <div className="overlay"><div ref={box} role="dialog" aria-modal="true" aria-label="Settings">
 */

/** Open dialogs, innermost last (ids so two of the same kind stay apart). */
const stack: symbol[] = []

/** True while any dialog opened through useModal is up. */
export const isModalOpen = () => stack.length > 0

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** The elements Tab can reach inside `node` (hidden ones skipped). */
export function focusableIn(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hidden && el.closest('[aria-hidden="true"],[inert]') === null,
  )
}

/** Tab / Shift+Tab inside `node`: wrap at the ends, and pull focus back in from outside. */
export function trapTab(node: HTMLElement, e: KeyboardEvent) {
  const items = focusableIn(node)
  if (items.length === 0) {
    e.preventDefault()
    node.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null
  const inside = !!active && node.contains(active)
  if (!inside) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  } else if (e.shiftKey && (active === first || active === node)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

export function useModal<T extends HTMLElement = HTMLDivElement>({
  onEscape,
  active = true,
  initialFocus = 'first',
  ref: ownRef,
}: {
  /** Escape pressed while this is the top dialog. Leave out for one that must be answered. */
  onEscape?: () => void
  /** False while the dialog is not shown (a component that stays mounted). */
  active?: boolean
  /** Where focus goes on opening: the first control (default) or the dialog's box itself. */
  initialFocus?: 'first' | 'box'
  /** Use this ref for the box instead of making one (the caller needs it too). */
  ref?: RefObject<T>
} = {}): RefObject<T> {
  const ownBox = useRef<T>(null)
  const ref = ownRef ?? ownBox
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape

  useEffect(() => {
    if (!active) return undefined
    const id = Symbol('modal')
    stack.push(id)
    const node = ref.current
    const before = document.activeElement as HTMLElement | null
    if (node && !node.contains(document.activeElement)) {
      const first =
        initialFocus === 'box'
          ? undefined
          : (node.querySelector<HTMLElement>('[data-autofocus]') ??
            focusableIn(node)[0])
      if (first) first.focus()
      else {
        if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1')
        node.focus()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return
      if (e.key === 'Escape') {
        // A menu or dropdown inside the dialog took this one.
        if (e.defaultPrevented) return
        escapeRef.current?.()
      } else if (e.key === 'Tab' && ref.current) {
        trapTab(ref.current, e)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const at = stack.indexOf(id)
      if (at >= 0) stack.splice(at, 1)
      // Back to where the user was, unless they already moved on.
      const now = document.activeElement
      if (
        before &&
        before.isConnected &&
        (!now || now === document.body || (node && node.contains(now)))
      ) {
        before.focus()
      }
    }
  }, [active])

  return ref
}
