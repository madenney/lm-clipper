import type { CSSProperties, ReactNode } from 'react'
import { useModal } from '../hooks/useModal'

/**
 * The app's one dialog frame: an overlay and a box with role="dialog", aria-modal and a label,
 * focus moved in and kept there, Escape and a click on the backdrop closing it (hooks/useModal.ts).
 * The look stays with the caller's own classes, so existing dialogs keep their styles.
 */
export default function Modal({
  label,
  labelledBy,
  overlayClassName,
  className,
  style,
  onClose,
  closeOnBackdrop = true,
  alert = false,
  initialFocus = 'first',
  children,
}: {
  /** What a screen reader calls it (or labelledBy: the id of its title). */
  label?: string
  labelledBy?: string
  overlayClassName: string
  className: string
  style?: CSSProperties
  /** Esc and the backdrop. Leave out for a dialog that has to be answered with its buttons. */
  onClose?: () => void
  /** False: a stray click outside does not close it (an Esc still does). */
  closeOnBackdrop?: boolean
  /** A question that needs an answer (role="alertdialog"). */
  alert?: boolean
  /** Where focus goes on opening: the first control (default) or the box itself (a dialog whose
   *  keys, like Space for panning, must not land on a button). */
  initialFocus?: 'first' | 'box'
  children: ReactNode
}) {
  const box = useModal({ onEscape: onClose, initialFocus })
  return (
    // The backdrop's click is a mouse convenience; Esc is the keyboard way out.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className={overlayClassName}
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        ref={box}
        className={className}
        style={style}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
