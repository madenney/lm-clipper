/** Window event that opens the welcome / getting started modal (App.tsx). */
export const SHOW_WELCOME_EVENT = 'lunar:showWelcome'

/**
 * Whether the welcome opens by itself when a project loads: only for a new one. A project that
 * already has steps of its own (anything besides the Replays pool, type "files") has been worked in,
 * so the four starting points would only be in the way. "Don't show this again" (hideWelcome) still
 * wins, and the ? button opens it whenever the user wants.
 */
export function shouldAutoShowWelcome(
  filters: { type: string }[] | null | undefined,
  hideWelcome: boolean | null | undefined,
): boolean {
  if (hideWelcome === true) return false
  return !(filters ?? []).some((f) => f.type !== 'files')
}
