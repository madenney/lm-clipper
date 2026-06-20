/* eslint-disable react/no-typos, no-unused-vars */
// Electron-only CSS property for marking custom-titlebar drag regions. It's
// real at runtime in the Chromium renderer but absent from React's CSSProperties
// (which follows the CSS standard), so augment it in once here. The side-effect
// import of 'react' is required so this `declare module` augments rather than
// redeclares it.
import 'react'

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}
