import type { KeyboardEvent } from 'react'

/** For a clickable span or div that is given role="button" and tabIndex={0}: Enter and Space
 *  press it, as they do a real button. */
export function keyboardClick(e: KeyboardEvent<HTMLElement>) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    e.currentTarget.click()
  }
}
