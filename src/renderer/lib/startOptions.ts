/**
 * The welcome modal's four start options (user, 2026-10-03): look for combos,
 * record full games, look for edgeguards, use AI. Each acts on the open
 * project's steps: Filters.tsx listens for START_OPTION_EVENT.
 */
export type StartOption = 'combos' | 'games' | 'edgeguards' | 'ai'
export const START_OPTION_EVENT = 'lunar:startOption'

export function chooseStartOption(option: StartOption) {
  window.dispatchEvent(new CustomEvent(START_OPTION_EVENT, { detail: option }))
}
