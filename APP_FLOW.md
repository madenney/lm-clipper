# LM Clipper — App Flow (LIVE)

The single source of truth for the app's entry / onboarding lifecycle: every
screen a user can hit from first launch to their first clip, when it shows, and
why. **If the flow changes, edit this file in the same commit** — and keep
`DEV_SCREENS` in `src/renderer/components/DevScreenSwitcher.tsx` in sync with the
"Dev id" column of the flow that is actually running.

> **Redesign mostly landed (agreed 2026-09-26, on `main`; none of it released).**
> [Target flow](#target-flow) is where we're going; [Running flow](#running-flow) is
> what the code does today. As each build step lands, update Running flow and the
> decision log.

---

## Principles

1. **The first win is watching one of your own clips.** Every screen either moves
   the user toward that or gets out of the way.
2. **One obvious action per screen.** Secondary options are quiet text, never a
   second big button.
3. **As few words as possible up front.** No paragraphs before the first clip;
   explanation lives in tooltips, Help, and the moment it's needed.
4. **Don't ask what we can detect or default.** Slippi folder, Dolphin Playback,
   ISO, output folder: detect first, ask only for what's missing, only when needed.
5. **No concepts before they matter.** A new user never has to understand
   "project" to get started — importing creates one.

---

## The model: replays come from places, land in your project

```
   This PC  ──┐
              ├──►  project  ──►  filters  ──►  clips
 Lunar DB  ───┘        │
                       └──►  (later) share to Lunar DB
```

- A **source** is where replays come from: **This PC** (Slippi folder, files,
  drag-drop) or **Lunar Database** (search → download → unzip/decompress → import).
- Every source ends the same way: `.slp` files on disk, imported into the project.
  A downloaded replay filters and plays exactly like a local one — the UI never
  makes the user think "local vs database."
- **Upload** ("Share to Lunar Database") is the same model in reverse. Designed as a
  slot only; not built. It needs a database ingestion endpoint, website ownership,
  and dedupe against the stored corpus — a cross-app contract, see
  `packages/contracts/README.md`.

**Names (one vocabulary, 2026-11-10).** A *replay* is the saved game file (.slp / .slpz);
a *game* is one match; a *clip* is a moment found in a game (a combo, an edgeguard). The
Lunar Database panel's tabs are **Download games** (whole games into your library),
**Pre-parsed moments** (search the combos and edgeguards Lunar already found, then download
only those games) and **Downloads** (progress and history). These are the names on screen,
in the changelog and in this file; the older working names (Find replays, Find clips,
Transfers) survive only in code comments and old decision-log entries below, and mean
Download games, Pre-parsed moments and Downloads.

**Not onboarding:** the **Lunar Database** panel (Download games · Pre-parsed moments ·
Downloads (named Transfers until 2026-10-04); `DatabasePanel.tsx`, hosted by `DatabaseDock.tsx` at the app root and
opened by every Lunar Database button and Add replays) is a tool the user opens
by hand. It never appears on its own and is not in `DEV_SCREENS`. On main since
2026-10-03, released in 3.0.0 (2026-11-13); see `docs/database-integration-handoff.md`.

---

## Target flow

| # | State | When it shows | What it is | Replaces |
|---|-------|---------------|-----------|----------|
| 1 | **Loading** | config still loading | unchanged | — |
| 2 | **First screen** | no project open, no recent projects | Logo + one primary action chosen from what the user has (below), then the other ways in as cards (Lunar Database · Choose replays · Empty project). Settings gear top right. Shown at once: while the Slippi folder is still being searched the primary slot reads "Looking for your Slippi replays..." and the other ways in are already there. | Start screen, Getting Started column |
| 2b | **Start screen** | no project open, has recent projects | Recent list first, then "+ Add replays" / Open. Returning users rarely see it (last project reopens). | Start screen |
| 3 | **Usage notice** | until OK is clicked, on the start screen and in a project alike | A small card at the bottom: "Clipper sends anonymous usage stats (no replays, names or file paths)." with Turn off (Settings › Diagnostics), Privacy and OK. Was a 12 px grey line that only the start screen showed and that vanished when a project opened. | Consent banner |
| 4 | **Add replays** | tray empty state, and "+ Add replays" in a project | Two sources: *From this PC* · *From Lunar Database*. | Import panel |
| 5 | **Downloads** | while a Lunar DB transfer runs | Inline tray progress ("Downloading 1,000 games · 34%"); history behind a small link. | Downloads tab (was Transfers) |
| 6 | **Workspace** | project has files | Opens on Combos, already running, newest replays first so clips appear fast; switcher "Combos · Edgeguards · Custom" at top, detail in tooltips. | "What to make?" modal |
| 7 | **Setup Wizard** | Play/Record needs a missing path | Auto-detect Playback Dolphin + ISO (Slippi Launcher install/settings); ask one missing field at a time with a short "Where's this?" link; output folder defaults to Videos and is only asked on Record. Auto-resumes the action. | Setup Wizard |
| — | **Getting Started** | first time a project is open each session, **only for a new project (no steps beyond the Replays pool; owner 2026-11-10)**, until "Don't show this again"; ? in the top bar; Help menu | Welcome modal with a "Don't show this again" box. | Welcome modal + column |

**First screen — the one action adapts:**

```
Slippi folder found:                     No replays found:

      [logo] Lunar Clipper                     [logo] Lunar Clipper

  Found 2,341 replays in your Slippi 📁     [ Browse Lunar Database ]
  folder                                                or
        [ Import them ]                    [Choose replays] [Empty project]
              or                             You can also drop replays
  [Lunar Database] [Choose replays]           anywhere.
  [Empty project]
  You can also drop replays anywhere.                                  ⚙ top right
```

The no-replays user is the one we lose today; the database gives them something
to try the app on immediately.

**Lunar Database panel, trimmed for new users:** opens with player / character /
stage + Search. Batch size, sources, order behind "More filters". Standalone ZIP
extraction moves from its Extract tab to the File menu (done 2026-10-02 on the
branch: File › Extract Replays from Archives… / from Folder…; progress in
Transfers).

### Happy path (target)

```
Launch
  ├─ returning user → reopens last project ───────────────► Workspace (6)
  └─ new user → First screen (2) + consent line (3)
        ├─ Slippi folder → [Import them] ─┐
        ├─ drop files ────────────────────┼─► lands in My Replays, import
        └─ [Browse Lunar Database] ───────┘   (DB: download progress in tray, 5)
                                          ▼
                     Workspace (6): combos already running → clips appear
                                          │  Play
                                          ▼
                     Setup Wizard (7) only if something's missing → clip plays
```

Normal Slippi install: **launch → Import → Play** — two clicks to a clip.

### Build order

1. ✅ This document.
2. ✅ **On `main`**: first screen (2/2b), consent line (3), no New Project step,
   "What to make?" modal removed, first-run Combos auto-run (6), Getting Started
   Help-only. Still to do here: the Combos · Edgeguards · Custom switcher. The
   Lunar Database line stays hidden until step 3.
3. ✅ (merged to main 2026-10-03; in-app review in progress) **Resume `wip/clipper-database`** (needs the user's go-ahead in
   `docs/current-work.md`/`AGENTS.md`): merge `main`, "+ Add replays" → DB panel
   (4), tray download progress (5), trimmed panel filters, Extract → File menu,
   first in-app UI review, then show the DB line on the first screen.
4. Setup Wizard detection + one-field-at-a-time (7); Playback-build walkthrough
   from `TODO.md`.
5. Later: upload slot → real upload once the database side exists.

### Open questions (defaults in bold; revisit while building)

- Auto-run on huge imports: **parse the newest ~200 replays first so clips show
  fast, rest in the background.**
- Projects on the first screen: **hidden; a small "Open project" text link only.**
- DB on the first screen when a Slippi folder exists: ~~one quiet "or browse"
  line~~ **a card under "Import them", with Choose replays and Empty project**
  (user, 2026-10-03: the options must be visible; offer an empty project).

---

## Decision log (why it's like this — stop relitigating)

**2026-10-09 (user):** "chuck animations all over the place, make it a bit more flashy."
Motion lives in `styles/Motion.css` (imported last) and `lib/motion.ts`: dialogs and
panels fade + rise, menus drop, notices slide up, the first screen arrives in turn,
filter steps slide in, a finished step glows once and its count glides to the new
number, the tray fades (opacity only: the GPU layer tracks positions) on a new step or
page, Find replays' icons/amounts respond, downloads rows arrive and "Complete" pops.
150–420 ms, never delaying an action; none on playback, recording or individual clips;
all off with the OS's reduced-motion setting (spinners keep spinning).

**2026-10-08 (user):** Find replays was overwhelming (a full search form, a
131,000-page list). Now it reads like the website and asks two questions: **What
games?** (player/tournament, character vs character, quick picks, More filters)
and **How many?** (200 quick start, 1,000, 10,000, All). The list is an optional
collapsed preview (tick games there). The button says what you get ("Create
project with 200 Fox games") and the line under it says what happens and how long
(packed on the Lunar Database, downloaded, unpacked). 200 is the default and goes
game by game (no export queue). Starting closes the panel; the empty Replays step
shows "Your games are on the way" with progress (`IncomingReplays`).

**2026-10-08 (user):** Look for combos / edgeguards on a project with **no replays**
(e.g. Start empty project, then the welcome option) still fills in the steps, but
selects the **Replays** step, whose empty tray shows the import options, instead of
an empty result. The steps wait ("After import") and run by themselves as soon as
replays are in. `Filters.tsx` `startOption` / the pending-run effect.

**2026-10-03 (user):** the welcome modal comes back, but not on the first
screen: it opens the first time someone reaches the Workspace in a session and
keeps doing so until they tick "Don't show this again"; a ? button in the top
bar reopens it. (Supersedes "Getting Started: Help menu only".)
Its content is four start options in a 2x2 grid (user, 2026-10-03): **Look for
combos** (runs the combo steps), **Record full games** (selects the Replays pool,
whose results are whole games), **Look for edgeguards** (adds/runs Edgeguards
Parser + Edgeguard Filter), **Use AI** (adds an **AI Filter** step: describe it,
"Copy & open ChatGPT/Claude" with a prompt made for it, "Paste answer"; Clipper
never calls an AI and pays for nothing; the code runs like Custom Code, which
stays its own thing). `lib/startOptions.ts`; Filters.tsx acts on them.
New projects start with just the Replays pool (`includeDefaultFilters` now
defaults to off) and nothing auto-runs: picking Combos or Edgeguards fills in
the steps (`applyStarterChain`: parser, filter, sort; asks before replacing
other steps) and runs them if there are replays, after any import finishes.
Full games just selects the pool.

**2026-09-26 redesign:**

- **No "project" step for new users.** Import with no project open lands in the
  one default workspace, **My Replays** (app data; `autoCreateUntitledProject`
  opens or creates it; it used to create `Untitled N.lunar` in Documents every
  time, see `docs/library-workspaces.md`, 2026-10-02). New Project now asks for
  a name and place (it's the explicit "named project" action). A New Project
  step before importing was a wall in front of the only thing the user came to do.
- **No "What to make?" modal.** Supersedes the Project Ideas decisions below:
  opening on a running Combos chain gets to clips faster than a three-card choice,
  and the switcher keeps Edgeguards/Custom one click away.
- **Getting Started is Help-only.** It duplicated itself (start-screen column +
  modal) and put ~100 words in front of a new user before they'd done anything.
- **Sources, not "local vs database."** Downloaded replays become ordinary
  project files, so filtering/playback need no database awareness.
- **Flow redesign lands on `main` before the database work.** It's useful alone,
  and doing them in sequence avoids conflicts on the same screens.

**Still current:**

- **Setup Wizard is lazy.** Only appears when Play/Record actually needs a path,
  then auto-resumes the attempted action — no forced setup wall up front.
- **The tray owns "get replays in."** It auto-detects the Slippi folder; the first
  screen reuses that detection rather than inventing another import path.

- **Auto-run reuses the old run hint's once-ever flag** (`hideRunHint`). It runs
  the Combo Filter through `runFilter`, so the 50k+ parser confirmation still
  guards huge imports, and it waits for the import to finish. Results stream in
  live, so the "parse newest ~200 first" idea isn't needed yet.
- **The usage notice is fixed at the bottom and stays until OK (2026-11-10).** The old in-flow
  top banner sat under the full-viewport `.main`, so real users never saw it
  (and so never dismissed it — which also silently blocked the old modal). Its successor, a
  line shown on the start screen only, disappeared when a project opened without ever being
  read; it is now a readable card shown everywhere until dismissed.
- **`applyStarterChain` stays** (atomic, server-side: keeps the Game Filter,
  swaps the downstream chain) as the mechanism for the planned switcher.

---

## Running flow

| # | State | When it shows | Dev id | Code anchor |
|---|-------|---------------|--------|-------------|
| 1 | **Loading** | config still loading | `loading` | `App.tsx` `if (!config) return <LoadingScreen/>` |
| 2 | **First screen** | no project open, no recent projects | `empty` | `Main.tsx` EmptyState (`isNewUser`). Slippi folder found: "Import them" (folder icon opens the Slippi folder) + cards Lunar Database · Choose replays · Empty project. None found: **Browse Lunar Database** (opens Pre-parsed moments) + cards Choose replays · Empty project. Both: "You can also drop replays anywhere", Settings gear top right (2026-10-03). |
| 2b | **Start screen** | no project open, has recent projects | `empty` (with recents) | `Main.tsx` EmptyState |
| 3 | **Usage notice** | any screen, until OK (`!consentNoticeSeen`) | `consent` | `App.tsx` `showConsent`; `ConsentNotice.tsx` |
| 4 | **Add replays** | project open, no files yet, Game Filter selected; and **+ Add replays** in the top bar (dialog) | — (needs real project) | `AddReplays.tsx` (tray empty state, `AddReplaysDialog` from `Top.tsx`): *From this PC* (Slippi folder import, choose files, unpack ZIP/SLPZ, drop) · *From Lunar Database* (Download games / Pre-parsed moments) |
| 5 | ~~First-run auto-run~~ | removed 2026-10-03: nothing runs until the user picks a welcome option or presses Run | — | `Filters.tsx` `startOption` (runs after any import finishes) |
| 6 | **Workspace** | project has files | — (needs real project) | `Main.tsx` |
| 7 | **Setup Wizard** | on Play/Record if Dolphin/ISO/output missing (a link to get the Slippi Launcher; compressed ISOs are accepted) | `setup-play` / `setup-record` | `SetupWizard.tsx`; gates in `Main.tsx` Play/Record; auto-resume via `pendingAction` |
| — | **What's new** | once after an update (what changed since the version last seen); the whole history from Settings › About or Help › What's New | `whats-new` (the popup) / `whats-new-history` | `WhatsNew.tsx`; `App.tsx` `whatsNew`; `constants/changelog.ts` |
| — | **Getting Started** | auto: first time a project is open in a session, only when the project has no steps beyond the Replays pool, unless `config.hideWelcome` ("Don't show this again") (`shouldAutoShowWelcome` in `lib/welcome.ts`); ? button in the top bar; Help → Welcome / Getting Started. With no project open, choosing an option first opens My Replays, then acts (`pendingStartOptionRef`); if that fails it says why. | `welcome` | `GettingStarted.tsx` (WelcomeModal); `App.tsx` `showWelcome`, `welcomeAutoShownRef`, `pendingStartOptionRef`; `lib/welcome.ts` event |

> Rows without a dev id depend on real archive/file state, not a forced flag.
> Use **new user** in the dev switcher to walk them for real.

## Maintaining this

1. Adding/removing/retiming a screen → update the running flow's table AND
   `DEV_SCREENS` (`src/renderer/components/DevScreenSwitcher.tsx`) in the same
   commit.
2. The dev switcher is the live QA tool: force any screen from the dropdown
   (development builds only: a packaged build never shows it, whatever `testMode`
   says in `lm-clipper.json`) to see exactly what a user sees — no config reset,
   no faking first-run conditions. It persists (`devForceScreen`); set it back to
   "Normal" when done, or every dev launch opens the forced screen.
3. To walk the whole flow as a brand-new user, use **new user** in the dev
   switcher: it resets config to a fresh install (your settings are saved to
   `lm-clipper.json.dev-backup`, never overwritten by repeat resets; projects on
   disk untouched) and restarts. **restore my settings** puts them back.
4. When you catch yourself asking "wait, why is it like this?" → it's in the
   decision log above. If it isn't, add it.

## Shared behaviour on every screen (2026-11-10)

- **Dialogs** use one frame (`components/Modal.tsx`, `hooks/useModal.ts`): `role="dialog"`,
  focus moves in and Tab stays inside, Esc and a click on the backdrop close only the top one,
  focus goes back to where it was. A new dialog uses it; do not write another overlay.
- **Window shortcuts** (the tray's Delete / Esc / Ctrl+A / Z / X) leave a key alone while the
  user types or a dialog or dropdown is open (`lib/keyboardScope.ts`).
- **Failures say why.** Import, Open, New, Save as, drop and Add replays turn an `{ error }`
  reply into a plain sentence in the notice line (`lib/openNotice.ts`); a cancelled dialog is
  silent.
- **A crash in one part** (the Database panel, the dialogs layer, the workspace) is caught by its
  own error boundary and written to `main.log`; the workspace's has Close project.
