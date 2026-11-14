/** Window event that opens the Settings window, optionally on one section (Top.tsx). */
export const OPEN_SETTINGS_EVENT = 'lunar:openSettings'

export type OpenSettingsDetail = { section?: string }

export function openSettings(section?: string) {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, {
      detail: { section },
    }),
  )
}
