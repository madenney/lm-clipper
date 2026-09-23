# LM Clipper — App Flow (LIVE)

The single source of truth for the app's entry / onboarding lifecycle: every
screen a user can hit from first launch to their first clip, when it shows, and
why. **If the flow changes, edit this file in the same commit** — and keep
`DEV_SCREENS` in `src/renderer/components/DevScreenSwitcher.tsx` in sync with the
"Dev id" column below.

---

## The mental model

Every onboarding surface is exactly one of two kinds:

- **Reference** — *"how does this app work?"* Passive, always available. → **Getting Started**.
- **Guidance** — *"what do I do right now?"* Active, fires at the moment its action matters. → the **tray Import panel** and the **"What to make?" modal**.

The two "welcome"-ish modals are NOT redundant: Getting Started is reference,
Project Ideas is guidance. They coexist on purpose. Don't merge them; just keep
their names distinct.

---

## Canonical flow

| # | State | When it shows | Kind | Dev id | Code anchor |
|---|-------|---------------|------|--------|-------------|
| 1 | **Loading** | config still loading | — | `loading` | `App.tsx` `if (!config) return <LoadingScreen/>` |
| 2 | **Start screen** | no project open (`archive === null`) | — | `empty` | `Main.tsx` EmptyState |
| 3 | **Consent banner** | 1st launch, until dismissed (`!consentNoticeSeen`) | reference | `consent` | `App.tsx` `showConsent`; `ConsentNotice.tsx` |
| 4 | **Getting Started** | start-screen column + Help→Welcome menu | **reference** | `welcome` | `GettingStarted.tsx` (WelcomeModal); `App.tsx` `showWelcome` |
| 5 | **Import panel** | project open, no files yet, Game Filter selected | **guidance** | — (needs real project) | `Tray.tsx` `.tray-import` empty state |
| 6 | **"What to make?" modal** | ONCE, right after the first import (`archive.files > 0`) | **guidance** | `project-ideas` | `ProjectIdeas.tsx`; trigger in `App.tsx` (`projectIdeasFiredRef`) |
| 7 | **Workspace** | project has files | — | — (needs real project) | `Main.tsx` |
| 8 | **Setup Wizard** | on Play/Record if Dolphin/ISO/output missing | guidance | `setup-play` / `setup-record` | `SetupWizard.tsx`; gates in `Main.tsx` Play/Record; auto-resume via `pendingAction` |

> Import panel (5) and Workspace (7) aren't in the dev switcher because they
> depend on real archive/file state, not a forced flag.

---

## The happy path (new user → first clip)

```
Launch
  │
  ├─ returning user → reopens last project ─────────────► Workspace (7)
  │
  └─ new user
       │
       ▼
   Start screen (2) + Consent banner (3)
   • New Project · Open · Recent · drag-drop
   • Getting Started column (4, reference)
       │
       │  New Project → empty project
       ▼
   Import panel (5, guidance)  ── "X replays found in your Slippi folder → Import all"
       │                          (drag-drop skips straight here with files already in)
       │  first import lands (archive.files > 0)
       ▼
   "What to make?" modal (6, guidance)  ── "You've got N replays loaded…"
   • Combos  → Combo Parser → Combo Filter → Sort (dps)
   • Edgeguards → Edgeguards Parser → Edgeguards Filter → Sort (edgeguard score)
   • Custom  → Custom Code filter
       │  pick a card → builds that chain → close
       ▼
   Workspace (7)  ── filter → select → Play / Record
       │  Play/Record with missing Dolphin/ISO/output
       ▼
   Setup Wizard (8) → fill paths → auto-resumes the action → first clip
```

---

## Decision log (why it's like this — stop relitigating)

- **Modal fires after the first import, not when a project opens.** An empty
  New Project would otherwise get the modal on top of the tray's own import
  prompt, and the cards would have no data to act on. Firing on `archive.files > 0`
  means it's always actionable and never covers the import panel. It also
  sidesteps the old consent-ordering fragility (files only exist after the user
  is already past consent).
- **Cards are actionable (build a filter chain), not just copy.** Picking one
  calls `applyStarterChain` (atomic, server-side) which keeps the Game Filter and
  swaps the downstream chain. Safe because the modal is strictly first-run.
- **Two onboarding modals coexist.** Getting Started = reference (how it works +
  Dolphin/ISO setup), reachable anytime. Project Ideas = guidance (what to make),
  fires once. Different jobs, different timing.
- **Setup Wizard is lazy.** Only appears when Play/Record actually needs a path,
  then auto-resumes the attempted action — no forced setup wall up front.
- **The tray Import panel owns "get replays in."** It auto-detects the Slippi
  folder and offers "Import all"; onboarding leans on it rather than duplicating
  an import CTA elsewhere.

---

## Maintaining this

1. Adding/removing/retiming a screen → update **this table** AND `DEV_SCREENS`
   (`src/renderer/components/DevScreenSwitcher.tsx`) in the same commit.
2. The dev switcher is the live QA tool: force any screen from the dropdown
   (dev build or Test Mode) to see exactly what a user sees — no config reset,
   no faking first-run conditions.
3. When you catch yourself asking "wait, why is it like this?" → it's in the
   decision log above. If it isn't, add it.
