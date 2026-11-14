/**
 * What changed in each release, newest first. Shown once after an update ("What's new")
 * and always in Settings > About > What's new / Help > What's New.
 *
 * Add an entry for EVERY release before you tag it (docs/packaging.md "Changelog"):
 * `version` must match package.json. Write for players, not developers: what they can
 * now do, one plain sentence each. No internal or owner-only tools.
 */
export interface ChangelogGroup {
  heading: string
  items: string[]
}

export interface ChangelogEntry {
  version: string
  /** Release date, YYYY-MM-DD. */
  date: string
  /** One line under the version number. */
  summary: string
  groups: ChangelogGroup[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '3.0.0',
    date: '2026-11-13',
    summary:
      'The Lunar Database is built in: find any combo or game and clip it without leaving Clipper.',
    groups: [
      {
        heading: 'Lunar Database',
        items: [
          'Download games: search the whole database by player, character, stage or tournament and download the games straight into your library.',
          'Pre-parsed moments: search combos and edgeguards across every game in the database, then download only the games you need.',
          'Downloads are fast and resumable, and come straight from storage.',
          'Downloaded games are kept compressed, so they take about 9 times less disk space.',
          'A Downloads panel shows what is coming, with your place in line.',
        ],
      },
      {
        heading: 'Recording',
        items: [
          'Recording windows stay hidden by default, so you can keep using your computer while clips record.',
          'Fast recording quality: high quality clips in a fraction of the time.',
          'Play, Record and Stitch sit at the top left; every recording option is in one Options menu.',
        ],
      },
      {
        heading: 'Filters',
        items: [
          'New AI Filter step: describe what you want, paste your own AI assistant’s answer, and Clipper runs it. Clipper never calls an AI itself.',
          'A game that cannot be read is skipped and counted instead of stopping a whole run, and Keep results saves what a run already found.',
          'Games with a computer player are left out by default, with an option to include them.',
        ],
      },
      {
        heading: 'The app',
        items: [
          'A new first screen, a Welcome guide, and a cleaner main view without the bottom bar.',
          'Dialogs keep the keyboard inside them and close with Esc, and you can move around the clip grid with the arrow keys (Enter opens a clip, Space selects it, P plays it, R records it).',
          'When an import or opening a project does not work, Clipper now says why.',
          'The console can follow several jobs at once, with search, copy and saved log files.',
          'This What’s new window: after every update you see what changed, and the full history lives in Settings > About.',
        ],
      },
    ],
  },
]
