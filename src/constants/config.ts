import { legalStages } from './stages'
import { sortedCharacters } from './characters'
import { moves } from './moves'
import { actionStates } from './actionStates'
import { deathDirections } from './deathDirections'
import { sortOptions } from '../models/methods/sort'

// Filter types that strictly require an upstream "producer" filter of a given
// type somewhere above them (mirrors combo parser → combo filter). Drives the
// add-filter menu gating, reorder validation, and the delete-block warning so
// you can't strand a consumer without the parser that feeds it.
export const REQUIRED_PRODUCER: Record<string, string> = {
  comboFilter: 'slpParser',
  reverse: 'slpParser',
  zeroToDeaths: 'slpParser',
  stageCenter: 'slpParser',
  edgeguardFilter: 'edgeguard',
  phantomFilter: 'phantom',
}

// Friendly name for a producer type, used in warnings ("requires … first").
export const PRODUCER_LABEL: Record<string, string> = {
  slpParser: 'combo parser',
  edgeguard: 'Edgeguards Parser',
  phantom: 'Phantom Hits',
}

// SINGLE SOURCE OF TRUTH for where native filters appear and in what order.
//
// - `main`        — the "+ Add Filter" dropdown, in this exact order. It's a
//                   workflow pipeline (parse → filter → order → thin), so the
//                   order is meaningful and deliberately NOT alphabetical.
// - `modalTabs`   — the "Browse more" modal's tabs, in display order.
// - `modalNatives`— which native filter ids live in each modal tab. This is
//                   membership only — the modal sorts each tab alphabetically,
//                   so the order within these arrays doesn't affect display.
//                   Code templates (defaults.ts `savedCustomFilters`) land in
//                   the same tabs via their matching `category` string.
//
// Any native filter not listed in `main` or `modalNatives` is simply hidden.
// `files` is the always-present root (never in the Add menu); `pressure` is
// parked (commented out of the registry) and intentionally absent here.
//
// The renderer derives the dropdown AND the native catalog entries from this,
// so a filter can't be double-listed or orphaned the way it could when the
// placement lived in two hand-maintained lists in Filters.tsx.
export const FILTER_LAYOUT: {
  main: string[]
  modalTabs: string[]
  modalNatives: Record<string, string[]>
} = {
  main: ['slpParser', 'comboFilter', 'sort', 'trim', 'deduplicate'],
  modalTabs: ['Kills', 'Combos', 'Sampling', 'Utility', 'Advanced'],
  modalNatives: {
    Kills: [
      'edgeguard',
      'edgeguardFilter',
      'phantom',
      'phantomFilter',
      'earlyQuitOut',
      'zeroToDeaths',
      'koDirection',
    ],
    Combos: ['reverse', 'stageCenter'],
    Sampling: ['randomSample', 'range'],
    Utility: ['afkDetection', 'removeStarKOFrames'],
    Advanced: ['custom', 'actionStateFilter'],
  },
}

export const filtersConfig = [
  {
    id: 'files',
    label: 'Game Filter',
    tooltip: 'Filter replay metadata',
    options: [
      {
        name: 'Char 1',
        id: 'char1',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Filter by Player 1 character.',
      },
      {
        name: 'Player 1',
        id: 'player1',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Filter by Player 1 display name / tag.',
      },
      {
        name: 'Player 1 CC',
        id: 'player1CC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Filter by Player 1 connect code.',
      },
      {
        name: 'Char 2',
        id: 'char2',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Filter by Player 2 character.',
      },
      {
        name: 'Player 2',
        id: 'player2',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Filter by Player 2 display name / tag.',
      },
      {
        name: 'Player 2 CC',
        id: 'player2CC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Filter by Player 2 connect code.',
      },
      {
        name: 'Stage',
        id: 'stage',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
        tooltip: 'Filter by stage.',
      },
    ],
  },
  {
    id: 'slpParser',
    label: 'Combo Parser',
    tooltip: 'Parse .slp for combo data',
    options: [
      {
        name: 'Min Hits',
        id: 'minHits',
        type: 'int',
        default: '2',
        tooltip: 'Minimum number of hits in a combo.',
      },
      {
        name: 'Max Hits',
        id: 'maxHits',
        type: 'int',
        default: '',
        tooltip: 'Maximum number of hits in a combo. Empty = no limit.',
      },
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
        tooltip: 'Stop parsing after this many files. Empty = parse all.',
      },
      {
        name: 'Comboer Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only parse combos performed by these characters.',
      },
      {
        name: 'Comboer Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only parse combos by players with these tags.',
      },
      {
        name: 'Comboer CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only parse combos by players with these connect codes.',
      },
      {
        name: 'Comboee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only parse combos received by these characters.',
      },
      {
        name: 'Comboee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only parse combos against players with these tags.',
      },
      {
        name: 'Comboee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only parse combos against players with these connect codes.',
      },
      {
        name: 'Combo Timeout',
        id: 'comboTimeout',
        type: 'int',
        default: '',
        placeholder: '45',
        tooltip:
          'Frames opponent must be out of hitstun before the combo ends. Lower = stricter, higher = more lenient. Default: 45 (~0.75s).',
      },
      {
        name: 'Did Kill',
        id: 'didKill',
        type: 'checkbox',
        default: false,
        tooltip: 'Only keep combos that resulted in a kill.',
      },
    ],
  },
  {
    id: 'earlyQuitOut',
    label: 'Early Quit Out',
    tooltip:
      'Finds kills the combo parser misses: the victim is comboed to a lethal percent, then quits out (holds L+R+A+Start) before the stock is actually taken. Emits one clip per game, tagged as a kill.',
    options: [
      {
        name: 'Kill Percent',
        id: 'killPercent',
        type: 'int',
        default: '80',
        placeholder: '80',
        tooltip:
          'Only keep quit-outs where the victim was at least this percent when they bailed — the "would this have killed?" gate. Lower = more inclusive; higher = only clear kill-percent situations.',
      },
      {
        name: 'Min Hits',
        id: 'minHits',
        type: 'int',
        default: '1',
        tooltip:
          'Minimum hits in the interrupted combo. 1 keeps single-hit denials (e.g. a lone would-be-lethal smash they quit on).',
      },
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
        tooltip: 'Stop parsing after this many files. Empty = parse all.',
      },
      {
        name: 'Comboer Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip:
          'Only keep quit-outs where the player who forced the quit is these characters.',
      },
      {
        name: 'Comboer Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip:
          'Only keep quit-outs by players with these tags (the one who forced the quit).',
      },
      {
        name: 'Comboer CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only keep quit-outs by players with these connect codes.',
      },
      {
        name: 'Comboee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip:
          'Only keep quit-outs where the player who QUIT is these characters.',
      },
      {
        name: 'Comboee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip:
          'Only keep quit-outs against players with these tags (the one who quit).',
      },
      {
        name: 'Comboee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only keep quit-outs against players with these connect codes.',
      },
      {
        name: 'Combo Timeout',
        id: 'comboTimeout',
        type: 'int',
        default: '',
        placeholder: '45',
        tooltip:
          'Frames the victim must be out of hitstun before the combo ends. Same as the Combo Parser. Default: 45 (~0.75s).',
      },
    ],
  },
  {
    id: 'comboFilter',
    label: 'Combo Filter',
    tooltip: 'Filter parsed combos',
    options: [
      {
        name: 'Min Hits',
        id: 'minHits',
        type: 'int',
        default: '4',
        tooltip: 'Minimum number of hits in a combo.',
      },
      {
        name: 'Max Hits',
        id: 'maxHits',
        type: 'int',
        default: '',
        tooltip: 'Maximum number of hits in a combo. Empty = no limit.',
      },
      {
        name: 'Min Damage',
        id: 'minDamage',
        type: 'int',
        default: '',
        tooltip: 'Minimum total damage dealt by the combo. Empty = no minimum.',
      },
      {
        name: 'Comboer Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Keep only combos performed by these characters.',
      },
      {
        name: 'Comboer Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Keep only combos by players with these tags.',
      },
      {
        name: 'Comboer CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Keep only combos by players with these connect codes.',
      },
      {
        name: 'Comboee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Keep only combos received by these characters.',
      },
      {
        name: 'Comboee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Keep only combos against players with these tags.',
      },
      {
        name: 'Comboee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Keep only combos against players with these connect codes.',
      },
      {
        name: 'Stage',
        id: 'comboStage',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
        tooltip: 'Keep only combos on these stages.',
      },
      {
        name: 'Did Kill',
        id: 'didKill',
        type: 'checkbox',
        default: true,
        tooltip: 'Only keep combos that resulted in a kill.',
      },
      {
        name: 'Count Pummels',
        id: 'countPummels',
        type: 'checkbox',
        default: false,
        tooltip:
          'Count grab pummels as individual hits in the combo hit count.',
      },
      {
        name: 'Nth Moves',
        id: 'nthMoves',
        type: 'nthMoves',
        options: moves,
        default: [],
        moves: [],
        tooltip:
          'Require specific moves at specific positions in the combo sequence.',
      },
    ],
  },
  {
    id: 'stageCenter',
    label: 'Stage Center Distance',
    tooltip:
      "Keep combos that started within a distance (in pixels) of the stage's center vertical line",
    options: [
      {
        name: 'Max Distance',
        id: 'maxDistance',
        type: 'int',
        default: '20',
        placeholder: '20',
        tooltip:
          'Maximum horizontal distance (pixels) from stage center (x=0) at the combo start. Lower = closer to the middle line.',
      },
      {
        name: 'Measure Attacker',
        id: 'useComboer',
        type: 'checkbox',
        default: false,
        tooltip:
          'Measure the attacker (comboer) position instead of the victim (comboee).',
      },
    ],
  },
  {
    id: 'reverse',
    label: 'Reverse Hit',
    tooltip: 'Filter for combos where the Nth hit was a reverse hitbox',
    options: [
      {
        name: 'Nth Move',
        id: 'n',
        type: 'positionDropdown',
        default: '',
        tooltip:
          'Which hit in the combo to check for a reverse hitbox (e.g. 1 = first hit, -1 = last hit).',
      },
    ],
  },
  {
    id: 'actionStateFilter',
    label: 'Action State',
    tooltip: 'Filter clips by action states at specific frames',
    options: [
      {
        name: 'Start Frame',
        id: 'startFrom',
        type: 'int',
        default: '',
        placeholder: 'Clip start',
        tooltip:
          'Frame offset to begin searching from. Positive = from clip start, negative = from clip end. Empty = start from first frame.',
      },
      {
        name: 'Search Range',
        id: 'searchRange',
        type: 'int',
        default: '',
        placeholder: 'All frames',
        tooltip:
          'Number of frames to search. Positive = forward, negative = backward. 0 or empty = search all remaining frames.',
      },
      {
        name: 'Nth Move',
        id: 'startFromNthMove',
        type: 'positionDropdown',
        default: '',
        requiresParser: true,
        tooltip:
          "Start searching from this move's frame. Overrides Start Frame.",
      },
      {
        name: 'Offset',
        id: 'offset',
        type: 'int',
        default: '',
        tooltip:
          'Shift the start frame by +/- this many frames before searching.',
      },
      {
        name: 'Comboer State',
        id: 'comboerActionState',
        type: 'multiDropdown',
        options: actionStates,
        default: [],
        tooltip:
          "Filter clips by the attacker's action state during the search window. Without a parser, matches any player.",
      },
      {
        name: 'Comboer Custom IDs',
        id: 'comboerCustomIds',
        type: 'textInput',
        default: '',
        tooltip:
          'Comma-separated action state IDs for the Custom option (e.g. 43,44,45).',
        showWhenCustomField: 'comboerActionState',
      },
      {
        name: 'Comboee State',
        id: 'comboeeActionState',
        type: 'multiDropdown',
        options: actionStates,
        default: [],
        tooltip:
          "Filter clips by the defender's action state during the search window. Without a parser, matches any player.",
      },
      {
        name: 'Comboee Custom IDs',
        id: 'comboeeCustomIds',
        type: 'textInput',
        default: '',
        tooltip:
          'Comma-separated action state IDs for the Custom option (e.g. 43,44,45).',
        showWhenCustomField: 'comboeeActionState',
      },
      {
        name: 'Exclude',
        id: 'exclude',
        type: 'checkbox',
        default: false,
        tooltip:
          'Invert the filter — keep clips where the action state was NOT found.',
      },
      {
        name: 'Comboer Min X',
        id: 'comboerMinX',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Minimum X position for the comboer. Empty = no constraint.',
      },
      {
        name: 'Comboer Max X',
        id: 'comboerMaxX',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Maximum X position for the comboer. Empty = no constraint.',
      },
      {
        name: 'Comboer Min Y',
        id: 'comboerMinY',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Minimum Y position for the comboer. Empty = no constraint.',
      },
      {
        name: 'Comboer Max Y',
        id: 'comboerMaxY',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Maximum Y position for the comboer. Empty = no constraint.',
      },
      {
        name: 'Comboee Min X',
        id: 'comboeeMinX',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Minimum X position for the comboee. Empty = no constraint.',
      },
      {
        name: 'Comboee Max X',
        id: 'comboeeMaxX',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Maximum X position for the comboee. Empty = no constraint.',
      },
      {
        name: 'Comboee Min Y',
        id: 'comboeeMinY',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Minimum Y position for the comboee. Empty = no constraint.',
      },
      {
        name: 'Comboee Max Y',
        id: 'comboeeMaxY',
        type: 'int',
        default: '',
        group: 'position',
        tooltip: 'Maximum Y position for the comboee. Empty = no constraint.',
      },
    ],
  },
  {
    id: 'edgeguard',
    label: 'Edgeguards Parser',
    tooltip:
      'Finds kills by edgeguard: the victim is knocked offstage by a hit, attempts to recover in range of the ledge, and is denied — hit back out, ledge-stolen, or forced to land on stage and punished (even killed off the top) — dying without ever recovering in between. Each clip starts at the launching hit (with a configurable lead-in) and is tagged with metrics (recovery attempts, offstage depth, forced-landing reads, clean-putaway timing, etc.) the Edgeguards Filter can refine.',
    options: [
      {
        name: 'Edgeguarder Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep edgeguards performed by these characters.',
      },
      {
        name: 'Edgeguarder Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep edgeguards by players with these tags.',
      },
      {
        name: 'Edgeguarder CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only keep edgeguards by players with these connect codes.',
      },
      {
        name: 'Edgeguardee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep edgeguards against these characters.',
      },
      {
        name: 'Edgeguardee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep edgeguards against players with these tags.',
      },
      {
        name: 'Edgeguardee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only keep edgeguards against players with these connect codes.',
      },
      {
        name: 'Stage',
        id: 'stageFilter',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
        tooltip: 'Only parse edgeguards on these stages.',
      },
      {
        name: 'Min Offstage Frames',
        id: 'minOffstageFrames',
        type: 'int',
        default: '20',
        tooltip:
          'Reject quick deaths: the victim must spend at least this many frames offstage before the KO (60 = 1 second).',
      },
      {
        name: 'Range Leniency %',
        id: 'rangeLeniency',
        type: 'int',
        default: '100',
        tooltip:
          'Scales each character\'s recovery range when deciding if a recovery was "in range" (100 = use the built-in per-character range). Raise it (e.g. 130) to catch more borderline-deep recoveries; lower it (e.g. 80) to keep only clearly-recoverable situations.',
      },
      {
        name: 'Include Ledge-Steals',
        id: 'includeLedgeSteals',
        type: 'checkbox',
        default: true,
        tooltip:
          'Also catch no-contact edgeguards where the edgeguarder takes the ledge to deny the recovery.',
      },
      {
        name: 'Max Lookback Frames',
        id: 'maxLookbackFrames',
        type: 'int',
        default: '1200',
        tooltip:
          'Safety cap on how far back from the KO the sequence can start (1200 = 20 seconds). Normally the start is set by when the victim was last in control; this just bounds runaway clips.',
      },
      {
        name: 'Max Actionable Frames On Stage',
        id: 'maxActionableFrames',
        type: 'int',
        default: '0',
        tooltip:
          'How many frames the victim may be actionable (in control) back on the stage before it counts as a recovery, not an edgeguard. 0 (default) = the moment they regain control on stage — or grab the ledge — the edgeguard is over. Landing lag does NOT count as actionable, so forced onstage landings are still caught.',
      },
      {
        name: 'Lead-in Frames',
        id: 'leadInFrames',
        type: 'int',
        default: '30',
        tooltip:
          'Start the clip this many frames BEFORE the first frame of the move that knocks the opponent offstage, so it opens with a beat of lead-up. 0 = start exactly on the move.',
      },
    ],
  },
  {
    id: 'phantom',
    label: 'Phantom Hits',
    tooltip:
      'Finds true phantom hits (glancing blows): a hitbox grazes a hurtbox by <0.01 units, dealing half damage with NO knockback. Detected by the two documented signatures — the DEFENDER freezes but the ATTACKER does not (a normal hit freezes both, so crouch-cancels and teched hits are excluded), and the damage lands AFTER the freeze instead of on contact (which excludes projectiles like lasers). Genuinely rare (~1 per 8–20 games). The flagship case is a phantom Rest — Puff’s Rest grazes for no knockback and is left asleep. Each phantom becomes its own clip, tagged with metrics + a score (Rest phantoms rank highest).',
    options: [
      {
        name: 'Attacker Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep phantoms landed by these characters.',
      },
      {
        name: 'Attacker Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep phantoms landed by players with these tags.',
      },
      {
        name: 'Attacker CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only keep phantoms landed by players with these connect codes.',
      },
      {
        name: 'Victim Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep phantoms suffered by these characters.',
      },
      {
        name: 'Victim Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep phantoms suffered by players with these tags.',
      },
      {
        name: 'Victim CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only keep phantoms suffered by players with these connect codes.',
      },
      {
        name: 'Stage',
        id: 'stageFilter',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
        tooltip: 'Only parse phantoms on these stages.',
      },
      {
        name: 'Min Damage',
        id: 'minDamage',
        type: 'int',
        default: '1',
        tooltip:
          'Only keep phantoms that dealt at least this much % (a phantom deals HALF the move’s damage, so even a jab phantom is tiny — 1 keeps them). Raise it (e.g. 6–8) to isolate phantoms of big moves only.',
      },
      {
        name: 'Lead-in Frames',
        id: 'leadInFrames',
        type: 'int',
        default: '45',
        tooltip:
          'Start the clip this many frames BEFORE the phantom hit, for a beat of lead-up (45 = 0.75s).',
      },
      {
        name: 'Tail Frames',
        id: 'tailFrames',
        type: 'int',
        default: '90',
        tooltip:
          'End the clip this many frames AFTER the phantom hit, to show the non-reaction and what follows (90 = 1.5s).',
      },
    ],
  },
  {
    id: 'phantomFilter',
    label: 'Phantom Filter',
    tooltip:
      'Refines Phantom Hits output by the metrics stored on each clip — no .slp re-parse, so it’s fast and free to re-run. Pick a Move (e.g. Rest) and/or Attacker/Victim character for, say, a phantom-Rest reel; or filter by damage / hitlag / victim percent.',
    options: [
      {
        name: 'Move',
        id: 'move',
        type: 'multiDropdown',
        options: actionStates,
        default: [],
        tooltip:
          'Only keep phantoms of these moves — matched by the ATTACKER’s animation (reliable, unlike the stored move id). E.g. Rest for phantom Rests, or Forward Air / Down Smash. Empty = any move. Pair with Attacker Char (e.g. Puff + Rest).',
      },
      {
        name: 'Min Damage',
        id: 'minDamage',
        type: 'int',
        default: '',
        tooltip:
          'Keep phantoms that dealt at least this much %. Raise to isolate phantoms of bigger moves.',
      },
      {
        name: 'Max Damage',
        id: 'maxDamage',
        type: 'int',
        default: '',
        tooltip: 'Keep phantoms that dealt at most this much %.',
      },
      {
        name: 'Min Hitlag',
        id: 'minHitlag',
        type: 'int',
        default: '',
        tooltip:
          'Keep phantoms whose freeze lasted at least this many frames (bigger freeze = bigger move phantomed).',
      },
      {
        name: 'Min Victim %',
        id: 'minVictimPercent',
        type: 'int',
        default: '',
        tooltip:
          'Keep phantoms where the victim was at least this %  — the funniest phantoms are the ones that should have killed.',
      },
      {
        name: 'Attacker Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep phantoms landed by these characters.',
      },
      {
        name: 'Attacker Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep phantoms landed by players with these tags.',
      },
      {
        name: 'Attacker CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only keep phantoms landed by players with these connect codes.',
      },
      {
        name: 'Victim Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep phantoms suffered by these characters.',
      },
      {
        name: 'Victim Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep phantoms suffered by players with these tags.',
      },
      {
        name: 'Victim CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only keep phantoms suffered by players with these connect codes.',
      },
    ],
  },
  /* Pressure filter parked for now — re-enable by uncommenting this entry plus
     the wiring in src/models/methods/index.ts and src/models/methods/sort.ts.
     The algorithm itself (src/models/methods/pressure.ts) is kept intact.
  {
    id: 'pressure',
    label: 'Pressure Parser',
    tooltip:
      'Finds sustained "pressure" stretches — where the attacker keeps the opponent on the back foot (shield, hitstun, knockdown/tech, ledge) at close range. Builds a per-frame advantage curve and grabs the long high stretches. Each clip is tagged with pressure metrics + a score. Reads .slp directly (no parser required).',
    options: [
      {
        name: 'Attacker Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep pressure applied by these characters.',
      },
      {
        name: 'Attacker Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep pressure by players with these tags.',
      },
      {
        name: 'Attacker CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only keep pressure by players with these connect codes.',
      },
      {
        name: 'Defender Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep pressure against these characters.',
      },
      {
        name: 'Defender Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep pressure against players with these tags.',
      },
      {
        name: 'Defender CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only keep pressure against players with these connect codes.',
      },
      {
        name: 'Stage',
        id: 'stageFilter',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
        tooltip: 'Only parse pressure on these stages.',
      },
      {
        name: 'Threshold',
        id: 'threshold',
        type: 'int',
        default: '5',
        tooltip:
          'Pressure-curve level (0-10) the stretch must stay at or above. Lower = the curve stays above the bar through more ebbs, giving longer/more-prolonged clips; higher = only the most relentless stretches.',
      },
      {
        name: 'Min Duration Frames',
        id: 'minDurationFrames',
        type: 'int',
        default: '200',
        tooltip:
          'A pressure stretch must last at least this many frames (200 ≈ 3.3 seconds) — the length floor. Short bursts are rejected; lower it if you want shorter clips too.',
      },
      {
        name: 'Smoothing Window',
        id: 'smoothingWindow',
        type: 'int',
        default: '60',
        tooltip:
          'Frames of trailing moving-average applied to the pressure curve. This is the main PROLONGED-clip lever: a bigger window keeps the curve elevated across rolls/repositions/brief hits, stitching a whole back-and-forth exchange into one long clip instead of fragmenting it. Smaller = tighter, more isolated bursts.',
      },
      {
        name: 'Max Dip Frames',
        id: 'maxDipFrames',
        type: 'int',
        default: '70',
        tooltip:
          'Tolerate dips below threshold up to this many frames before ending a stretch. This is the main LENGTH knob — raise it to merge bursts of pressure (with brief resets/repositions between them) into one longer clip; lower it for tight, isolated bursts.',
      },
      {
        name: 'Close Range',
        id: 'closeRange',
        type: 'int',
        default: '40',
        tooltip:
          'Distance under which attacker and defender count as "in close range" for the proximity signal.',
      },
      {
        name: 'Offense Weight',
        id: 'offenseWeight',
        type: 'int',
        default: '4',
        tooltip:
          'How much a frame adds when the attacker is attacking in close range — the relentless-aggression driver. The eval needs BOTH this and the defender being on the back foot to clear threshold.',
      },
      {
        name: 'Shield Weight',
        id: 'shieldWeight',
        type: 'int',
        default: '3',
        tooltip:
          'How much a frame adds when the defender is shielding — the signature of shield pressure. (Scrambling/dodging counts for a fraction of this.)',
      },
      {
        name: 'Hitstun Weight',
        id: 'hitstunWeight',
        type: 'int',
        default: '3',
        tooltip:
          'How much a frame adds when the defender is in hitstun (getting hit). In the extended-advantage model this is the attacker WINNING, so it keeps a long shield→hit→shield exchange together instead of splitting it. A clip still must build real shield contact (Min Shield Hits) to count, so pure juggles are dropped.',
      },
      {
        name: 'Proximity Weight',
        id: 'proximityWeight',
        type: 'int',
        default: '1',
        tooltip: 'How much a frame adds when the two are within close range.',
      },
      {
        name: 'Min Shield Hits',
        id: 'minShieldHits',
        type: 'int',
        default: '2',
        tooltip:
          'Reject a stretch unless the attacker landed at least this many distinct hits on the shield — this is what keeps it shield-pressure (not a pure combo). A clip must ALSO crack into an opening or kill to be kept. Raise it to demand more shield contact before the conversion.',
      },
      {
        name: 'Opening Bonus',
        id: 'openingBonus',
        type: 'int',
        default: '5',
        tooltip:
          'Score bonus per "opening" — when the shield pressure cracks the defender into a hit or a grab. Not required to keep a clip, but it makes the cool ones rank higher.',
      },
      {
        name: 'Require Kill',
        id: 'requireKill',
        type: 'checkbox',
        default: false,
        tooltip:
          'Only keep pressure stretches that end in the defender losing a stock.',
      },
      {
        name: 'Kill Bonus',
        id: 'killBonus',
        type: 'int',
        default: '5',
        tooltip: 'Score bonus added when a stretch ends in a kill.',
      },
    ],
  },
  */
  {
    id: 'edgeguardFilter',
    label: 'Edgeguards Filter',
    tooltip:
      'Refine Edgeguards Parser results by their stored metrics (hits, offstage duration, ledge distance, depth, ledge-steals, etc.). Must come after an Edgeguards Parser.',
    options: [
      {
        name: 'Min Hits',
        id: 'minHits',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the victim was hit at least this many times.',
      },
      {
        name: 'Max Hits',
        id: 'maxHits',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards with at most this many hits (e.g. 0 for pure no-contact gimps).',
      },
      {
        name: 'Min Offstage Frames',
        id: 'minOffstageFrames',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the victim spent at least this many frames offstage (60 = 1s).',
      },
      {
        name: 'Max Offstage Frames',
        id: 'maxOffstageFrames',
        type: 'int',
        default: '',
        tooltip: 'Keep edgeguards no longer than this many offstage frames.',
      },
      {
        name: 'Max Ledge Distance',
        id: 'maxLedgeDist',
        type: 'int',
        default: '',
        tooltip:
          'Keep only edgeguards where the victim got within this many units of the ledge (smaller = closer / more clearly recoverable).',
      },
      {
        name: 'Min Horizontal Depth',
        id: 'minDepthX',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the victim was taken at least this far out horizontally (larger = deeper offstage).',
      },
      {
        name: 'Max Lowest Y',
        id: 'maxMinY',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the victim dropped to at least this Y (negative = below the stage; e.g. -60 for deep spikes).',
      },
      {
        name: 'Min Recovery Attempts',
        id: 'minRecoveryAttempts',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the victim got to START at least this many distinct recovery moves before dying — the back-and-forth contest. 1 = a one-shot gimp; 2–3+ = a multi-exchange scramble (the strongest "interesting" signal).',
      },
      {
        name: 'Max Recovery Attempts',
        id: 'maxRecoveryAttempts',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards with at most this many recovery attempts (e.g. 1 to isolate clean one-and-done gimps).',
      },
      {
        name: 'Min Edgeguarder Depth',
        id: 'minEdgeguarderDepth',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the EDGEGUARDER committed at least this far past the ledge + below the stage (units). Larger = a deeper, riskier offstage chase. ~0 = barely dipped out; 30+ = a deep commit.',
      },
      {
        name: 'Max Edgeguarder Depth',
        id: 'maxEdgeguarderDepth',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the EDGEGUARDER committed at most this far out. Set it low (e.g. 7) to find the ones done WITHOUT leaving the stage \u2014 lasers, ledge-traps, hitting them as they come up. Those sit at 0-7; a real offstage chase is 30+.',
      },
      {
        name: 'Min Stage Touches',
        id: 'minStageTouches',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the victim was forced back onto the stage at least this many times (ledge covered → onstage landing punished back off). 1+ isolates the rare, premium forced-landing read.',
      },
      {
        name: 'Max Last-Hit-to-Death',
        id: 'maxLastHitToDeath',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards where the final hit killed within this many frames (60 = 1s). Low = a clean putaway; high = a lingering flail. Ignored for pure ledge-steal kills (no final hit).',
      },
      {
        name: 'Min Score',
        id: 'minScore',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards scoring at least this. Higher = flashier. Scores run ~6–45: ~6–10 is a plain one-attempt gimp, 15–25 is typical, 30+ is a multi-exchange scramble, a forced-landing read, or a deep chase the edgeguarder survived. Built from +6 per recovery attempt, +5 per stage touch (forced landing), up to +12 for denial right at the ledge, +edgeguarder depth/10, +5 for surviving a deep commit, +3 for a clean putaway, and +1.5 per hit (capped). Empty = no minimum.',
      },
      {
        name: 'Blocked by Hit',
        id: 'blockedByHit',
        type: 'dropdown',
        options: [
          { name: 'Required', id: 'yes' },
          { name: 'Excluded', id: 'no' },
        ],
        default: '',
        tooltip:
          'Whether a hit landed after the recovery attempt (the edgeguarder knocked them back out).',
      },
      {
        name: 'Ledge Steal',
        id: 'ledgeSteal',
        type: 'dropdown',
        options: [
          { name: 'Only ledge-steals', id: 'yes' },
          { name: 'Exclude ledge-steals', id: 'no' },
        ],
        default: '',
        tooltip:
          'No-contact edgeguards where the edgeguarder took the ledge to deny the recovery.',
      },
      {
        name: 'Edgeguarder Returned',
        id: 'edgeguarderReturned',
        type: 'dropdown',
        options: [
          { name: 'Required', id: 'yes' },
          { name: 'Excluded', id: 'no' },
        ],
        default: '',
        tooltip:
          'Whether the edgeguarder made it back safely onstage at the kill — a deep chase they survived reads as stylish.',
      },
      {
        name: 'Died Offstage',
        id: 'diedOffstage',
        type: 'dropdown',
        options: [
          { name: 'Only offstage KOs', id: 'yes' },
          { name: 'Only onstage / off-top KOs', id: 'no' },
        ],
        default: '',
        tooltip:
          'Splits the two flavours: "yes" = classic offstage KO (out a side or spiked); "no" = killed onstage / off the top after a forced landing (a punish read).',
      },
      {
        name: 'Edgeguarder Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep edgeguards performed by these characters.',
      },
      {
        name: 'Edgeguarder Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep edgeguards by players with these tags.',
      },
      {
        name: 'Edgeguarder CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only keep edgeguards by players with these connect codes.',
      },
      {
        name: 'Edgeguardee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only keep edgeguards against these characters.',
      },
      {
        name: 'Edgeguardee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only keep edgeguards against players with these tags.',
      },
      {
        name: 'Edgeguardee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only keep edgeguards against players with these connect codes.',
      },
    ],
  },
  {
    id: 'zeroToDeaths',
    label: 'Zero-to-Deaths',
    tooltip: 'Keep only combos that start near 0% and kill',
    options: [
      {
        name: 'Start Threshold',
        id: 'startThreshold',
        type: 'int',
        default: '5',
        tooltip:
          'Maximum starting percent to count as a zero-to-death. Default: 5%.',
      },
    ],
  },
  {
    id: 'afkDetection',
    label: 'AFK Detection',
    tooltip:
      'Filter clips where a player had little or no controller input (AFK/idle)',
    options: [
      {
        name: 'Max Inputs/sec',
        id: 'maxInputsPerSec',
        type: 'int',
        default: '2',
        tooltip:
          'Threshold for active input frames per second. Players at or below this are considered AFK. Default: 2.',
      },
      {
        name: 'Exclude AFK',
        id: 'exclude',
        type: 'checkbox',
        default: true,
        tooltip:
          'Remove clips where the opponent was AFK. Uncheck to keep only AFK clips.',
      },
    ],
  },
  {
    id: 'koDirection',
    label: 'KO Direction',
    tooltip: 'Filter KOs by blast zone direction',
    options: [
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
        tooltip: 'Stop processing after this many files. Empty = process all.',
      },
      {
        name: 'Direction',
        id: 'direction',
        type: 'multiDropdown',
        options: deathDirections,
        default: [],
        tooltip: 'Keep only KOs in these blast zone directions.',
      },
    ],
  },
  {
    id: 'removeStarKOFrames',
    label: 'Cut Star KO',
    tooltip: 'Trim star KO animations from the end of clips',
    options: [],
  },
  {
    id: 'deduplicate',
    label: 'Deduplicate',
    tooltip:
      'Remove duplicate clips (matches by game time, stage, frames, and characters)',
    options: [],
  },
  {
    id: 'trim',
    label: 'Trim',
    tooltip: 'Add or remove frames from the start/end of clips',
    options: [
      {
        name: 'Add Start Frames',
        id: 'addStartFrames',
        type: 'int',
        default: '',
        tooltip:
          'Frames to add before the clip starts. Use a negative value to trim the beginning.',
      },
      {
        name: 'Add End Frames',
        id: 'addEndFrames',
        type: 'int',
        default: '',
        tooltip:
          'Frames to add after the clip ends. Use a negative value to trim the end.',
      },
    ],
  },
  {
    id: 'randomSample',
    label: 'Random Sample',
    tooltip:
      'Keep a random handful of clips from the input — set how many you want out',
    options: [
      {
        name: 'Number of clips',
        id: 'count',
        type: 'int',
        default: '100',
        tooltip:
          'How many clips to keep, chosen uniformly at random. You get exactly this many (or all of them, if the input has fewer).',
      },
    ],
  },
  {
    id: 'range',
    label: 'Select Range',
    tooltip:
      'Keep only a specific chunk of clips by position — e.g. the 3050th through 3300th clip in the list. Great for recording a batch at a time without hand-counting.',
    options: [
      {
        name: 'From (position)',
        id: 'from',
        type: 'int',
        default: '',
        tooltip:
          'First clip to keep, counting from 1 at the top of the list. Blank = start from the very beginning.',
      },
      {
        name: 'To (position)',
        id: 'to',
        type: 'int',
        default: '',
        tooltip:
          'Last clip to keep, inclusive. Blank = go to the end. Example: From 3050, To 3300 keeps exactly those 251 clips, in order.',
      },
    ],
  },
  {
    id: 'sort',
    label: 'Sort',
    tooltip: 'Sort results',
    options: [
      {
        name: 'Sort Function',
        id: 'sortFunction',
        type: 'dropdown',
        options: sortOptions,
        default: 'dps',
        tooltip: 'Which metric to sort clips by.',
      },
      {
        name: 'Reverse',
        id: 'reverse',
        type: 'checkbox',
        default: false,
        tooltip: 'Reverse the sort order (ascending instead of descending).',
      },
    ],
  },
  {
    id: 'custom',
    label: 'Custom Code',
    tooltip: 'Run a custom JavaScript function',
    options: [
      {
        name: 'Code',
        id: 'code',
        type: 'code',
        default: `// \`clips\` = array of clip objects from the previous filter
// \`params\` = this filter's params (maxFiles, etc.)
// \`SlippiGame\` = slippi-js class — new SlippiGame(clip.path) to open files
//
// Return an array of clips to keep.

return clips.filter(clip => {
  return true
})`,
      },
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
        tooltip: 'Stop processing after this many files. Empty = process all.',
      },
    ],
  },
]

export const settingsCategories = [
  { key: 'paths', label: 'Paths' },
  { key: 'output', label: 'Output' },
  { key: 'video', label: 'Video Output' },
  { key: 'rendering', label: 'Gecko Codes' },
  { key: 'performance', label: 'Performance' },
  { key: 'general', label: 'General' },
  { key: 'slpz', label: 'SLPZ' },
] as const

export const videoConfig = [
  // Paths
  {
    label: 'Output Directory',
    default: '',
    id: 'outputPath',
    type: 'openDirectory',
    category: 'paths',
    tooltip: 'Where recorded video files are saved.',
  },
  {
    label: 'Melee .iso Path',
    default: '',
    id: 'ssbmIsoPath',
    type: 'openFile',
    category: 'paths',
    tooltip:
      'Path to your Super Smash Bros. Melee .iso file. Required for playback and recording.',
  },
  {
    label: 'Dolphin Path',
    default: '',
    id: 'dolphinPath',
    type: 'openFile',
    category: 'paths',
    tooltip:
      'Path to the Slippi Dolphin executable. Required for playback and recording.',
  },
  {
    label: 'Default Project Directory',
    default: '',
    id: 'defaultProjectDirectory',
    type: 'openDirectory',
    category: 'paths',
    tooltip:
      'Default location for new projects. Leave empty to use ~/Documents/Lunar Clipper.',
  },
  {
    label: 'FFmpeg Path Override',
    default: '',
    id: 'ffmpegPath',
    type: 'openFile',
    category: 'paths',
    tooltip:
      'Use a custom ffmpeg binary instead of the bundled one. Leave empty to use the default.',
  },
  // Output
  {
    label: 'Filename Pattern',
    default: '{index}',
    id: 'outputFilenamePattern',
    type: 'textInput',
    category: 'output',
    hint: '{character1}, {character2}, {stage}, {index}, {date}, {time}',
    tooltip:
      'Pattern for naming output video files. Use variables like {index}, {character1}, {stage}, etc.',
  },
  // Video Output
  {
    label: 'Recording Resolution',
    default: 2,
    id: 'resolution',
    type: 'dropdown',
    category: 'video',
    tooltip:
      'Internal rendering resolution multiplier for recorded videos. Higher = sharper but slower.',
    options: [
      { label: '1x - Low Quality (fast)', value: 2 },
      { label: '1.5x', value: 3 },
      { label: '2x - Normal Quality', value: 4 },
      { label: '2.5x', value: 5 },
      { label: '3x', value: 6 },
      { label: '4x - High Quality', value: 7 },
      { label: '5x', value: 8 },
      { label: '6x - Very High Quality', value: 9 },
      { label: '7x', value: 10 },
      { label: '8x - Too High Quality', value: 11 },
    ],
  },
  {
    label: 'Player Resolution',
    default: 2,
    id: 'playbackResolution',
    type: 'dropdown',
    category: 'video',
    tooltip: 'Internal rendering resolution multiplier for the preview player.',
    options: [
      { label: '1x - Low Quality (fast)', value: 2 },
      { label: '1.5x', value: 3 },
      { label: '2x - Normal Quality', value: 4 },
      { label: '2.5x', value: 5 },
      { label: '3x', value: 6 },
      { label: '4x - High Quality', value: 7 },
      { label: '5x', value: 8 },
      { label: '6x - Very High Quality', value: 9 },
      { label: '7x', value: 10 },
      { label: '8x - Too High Quality', value: 11 },
    ],
  },
  {
    label: 'Bitrate (kbps)',
    default: 15000,
    id: 'bitrateKbps',
    type: 'int',
    category: 'video',
    tooltip:
      'Video bitrate in kilobits per second. Higher = better quality, larger files.',
  },
  {
    label: 'Add Start Frames',
    default: 0,
    id: 'addStartFrames',
    type: 'int',
    category: 'video',
    tooltip:
      'Extra frames to add before every clip during recording. Applies globally on top of any Trim filter.',
  },
  {
    label: 'Add End Frames',
    default: 0,
    id: 'addEndFrames',
    type: 'int',
    category: 'video',
    tooltip:
      'Extra frames to add after every clip during recording. Applies globally on top of any Trim filter.',
  },
  {
    label: 'Final End Frames',
    default: 0,
    id: 'lastClipOffset',
    type: 'int',
    category: 'video',
    tooltip:
      'Extra frames to add after the very last clip in a batch. Useful to avoid abrupt cuts at the end.',
  },
  {
    label: 'Fullscreen',
    default: true,
    id: 'fullscreen',
    type: 'checkbox',
    category: 'video',
    tooltip:
      'Run Dolphin in fullscreen mode during recording. Recommended for clean output.',
  },
  {
    label: 'Concatenate Output',
    default: false,
    id: 'concatenate',
    type: 'checkbox',
    category: 'video',
    tooltip: 'Merge all recorded clips into a single video file using ffmpeg.',
  },
  {
    label: 'Convert to MP4',
    default: false,
    id: 'convertToMp4',
    type: 'checkbox',
    category: 'video',
    tooltip:
      'Convert the raw AVI output from Dolphin to MP4 for smaller file size and wider compatibility.',
  },
  // Rendering
  {
    label: 'Widescreen 16:9',
    default: false,
    id: 'widescreen',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Render in 16:9 widescreen instead of the native 4:3 aspect ratio. Also adjusts the Dolphin aspect ratio and ffmpeg scaling.',
  },
  {
    label: 'No Screen Shake',
    default: false,
    id: 'disableScreenShake',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Disable camera shake on hard hits and smash attacks. Gives a cleaner, more stable image.',
  },
  {
    label: 'Hide HUD',
    default: false,
    id: 'hideHud',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Remove the damage percentages, stock icons, and timer from the screen.',
  },
  {
    label: 'Fixed Camera',
    default: false,
    id: 'fixedCamera',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Lock the camera in a fixed position instead of following the players. Shows the full stage at all times.',
  },
  {
    label: 'No Magnifying Glass',
    default: false,
    id: 'disableMagnifyingGlass',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Hide the magnifying glass bubble that appears when a player is off-screen.',
  },
  {
    label: 'Hide Tags',
    default: false,
    id: 'hideTags',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Hide the nametag text that floats above characters during gameplay.',
  },
  {
    label: 'Hide Netplay Names',
    default: false,
    id: 'hideNames',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Hide the connect code / netplay name overlay shown at the bottom of the screen.',
  },
  {
    label: 'Game Music',
    default: false,
    id: 'gameMusic',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Play the in-game stage music during recording. Off by default so clips have clean game audio only.',
  },
  {
    label: 'Enable Chants',
    default: false,
    id: 'enableChants',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Allow the crowd to chant character names during gameplay. Off by default to keep audio clean.',
  },
  {
    label: 'No Electric SFX',
    default: false,
    id: 'noElectricSFX',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Remove the electric hit sound effects (the buzzing on moves like Fox up-smash, Pikachu thunder, etc.).',
  },
  {
    label: 'No Crowd Noise',
    default: false,
    id: 'noCrowdNoise',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Silence the background crowd ambience and reactions during gameplay.',
  },
  {
    label: 'Freeze FD Background',
    default: false,
    id: 'freezeFD',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      "Prevent Final Destination's cosmic background from cycling through its animation phases. Keeps it static for a cleaner look.",
  },
  {
    label: 'Center Align HUD',
    default: false,
    id: 'centerHud',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Force the damage percentages to be centered on screen (2-player layout) instead of spread to the corners.',
  },
  {
    label: 'Develop Mode',
    default: false,
    id: 'developMode',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Enable debug/develop mode. Allows access to frame advance, hitbox/hurtbox display overlays, and alternate camera angles.',
  },
  {
    label: 'Flash Red Failed L-Cancel',
    default: false,
    id: 'flashRedLCancel',
    type: 'checkbox',
    category: 'rendering',
    tooltip:
      'Character model flashes red when an L-cancel input is missed. Useful for technical/educational combo videos.',
  },
  // Performance
  {
    label: 'Dolphin Instances',
    default: 1,
    id: 'numCPUs',
    type: 'int',
    category: 'performance',
    tooltip:
      'Number of Dolphin processes to run in parallel during recording. More = faster but uses more CPU/RAM.',
  },
  {
    label: 'Clips per Batch',
    default: 1,
    id: 'slice',
    type: 'int',
    category: 'performance',
    tooltip:
      'Number of clips each Dolphin instance records before restarting. Higher values reduce Dolphin startup overhead.',
  },
  {
    label: 'CPU Threads',
    default: 1,
    id: 'numFilterThreads',
    type: 'int',
    category: 'performance',
    tooltip:
      'Number of worker threads for filter processing. More threads = faster filtering on multi-core CPUs.',
  },
  // General
  {
    label: 'Detect Duplicates on Import',
    default: false,
    id: 'detectDuplicatesOnImport',
    type: 'checkbox',
    category: 'general',
    warning: 'Can significantly slow down imports with large file counts',
    tooltip:
      'Skip files that are already in the project during import. Compares by file path.',
  },
  {
    label: 'Include Default Filters (Parser + Combo Filter)',
    default: true,
    id: 'includeDefaultFilters',
    type: 'checkbox',
    category: 'general',
    tooltip:
      'Automatically add a Combo Parser and Combo Filter when creating new projects.',
  },
  {
    label: 'Enable Filter Branching',
    default: false,
    id: 'branchingEnabled',
    type: 'checkbox',
    category: 'general',
    tooltip:
      'Advanced: let each filter choose its input (raw Files or any filter above it) instead of always reading from the filter directly above. Turns the filter chain into a tree. When off, existing branch links are kept but the chain runs linearly.',
  },
  {
    label: 'Warn on Parser Delete',
    default: true,
    id: 'warnOnParserDelete',
    type: 'checkbox',
    category: 'general',
    tooltip:
      'Show a confirmation dialog before deleting a combo parser that was run on many files.',
  },
  {
    label: 'Warn on Reset (over 1 min)',
    default: true,
    id: 'warnOnReset60s',
    type: 'checkbox',
    category: 'general',
    tooltip:
      'Show a mild confirmation before re-running a filter whose last run took over 1 minute.',
  },
  {
    label: 'Warn on Reset (over 10 min)',
    default: true,
    id: 'warnOnReset10m',
    type: 'checkbox',
    category: 'general',
    tooltip:
      'Show a confirmation before re-running a filter whose last run took over 10 minutes.',
  },
  {
    label: 'Warn on Reset (over 1 hour)',
    default: true,
    id: 'warnOnReset1h',
    type: 'checkbox',
    category: 'general',
    tooltip:
      'Show a strong confirmation before re-running a filter whose last run took over an hour.',
  },
  {
    label: 'Send Anonymous Usage Data',
    default: true,
    id: 'sendAnonymousUsage',
    type: 'checkbox',
    category: 'general',
    description:
      'Sends anonymous stats to help improve Lunar Clipper. No personal data is collected.',
    tooltip:
      'Send anonymous usage statistics to help improve Lunar Clipper. No personal data is collected.',
  },
  {
    label: 'Test Mode',
    default: false,
    id: 'testMode',
    type: 'checkbox',
    category: 'general',
    tooltip: 'Enable developer/debug features. Not needed for normal use.',
  },
  {
    label: 'Test Dolphin',
    id: 'testDolphin',
    type: 'button',
    category: 'general',
    buttonLabel: 'Launch Test',
    tooltip:
      'Launch Dolphin with the current settings to verify your paths and configuration work.',
  },
  // SLPZ
  {
    label: 'SLPZ Mode',
    default: 'ask',
    id: 'slpzMode',
    type: 'dropdown',
    category: 'slpz',
    options: [
      { label: 'Ask each time', value: 'ask' },
      { label: 'Extract to directory', value: 'extract' },
      { label: 'Replace in-place', value: 'replace' },
    ],
    tooltip:
      'How to handle .slpz files during import. "Ask" shows a dialog each time, "Extract" decompresses to a directory, "Replace" decompresses next to the original and deletes the .slpz.',
  },
  {
    label: 'SLPZ Output Directory',
    default: '',
    id: 'slpzOutputDir',
    type: 'openDirectory',
    category: 'slpz',
    tooltip:
      'Where to put decompressed .slp files when using "Extract to directory" mode.',
  },
  {
    label: 'slpz Binary Path',
    default: '',
    id: 'slpzPath',
    type: 'openFile',
    category: 'slpz',
    tooltip: 'Path to the slpz binary. Leave empty to use the bundled version.',
  },
]
