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
  edgeguardFilter: 'edgeguard2',
}

// Friendly name for a producer type, used in warnings ("requires … first").
export const PRODUCER_LABEL: Record<string, string> = {
  slpParser: 'combo parser',
  edgeguard2: 'Edgeguards Parser',
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
    id: 'comboFilter',
    label: 'Combo Filter',
    tooltip: 'Filter parsed combos',
    options: [
      {
        name: 'Min Hits',
        id: 'minHits',
        type: 'int',
        default: '3',
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
    label: 'Edgeguards (experimental)',
    tooltip: 'Parse for edgeguard sequences (experimental)',
    options: [
      {
        name: 'Edgeguarder Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only parse edgeguards performed by these characters.',
      },
      {
        name: 'Edgeguarder Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only parse edgeguards by players with these tags.',
      },
      {
        name: 'Edgeguarder CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip: 'Only parse edgeguards by players with these connect codes.',
      },
      {
        name: 'Edgeguardee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
        tooltip: 'Only parse edgeguards against these characters.',
      },
      {
        name: 'Edgeguardee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
        tooltip: 'Only parse edgeguards against players with these tags.',
      },
      {
        name: 'Edgeguardee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
        tooltip:
          'Only parse edgeguards against players with these connect codes.',
      },
      {
        name: 'Stage',
        id: 'stageFilter',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
        tooltip: 'Only parse edgeguards on these stages.',
      },
    ],
  },
  {
    id: 'edgeguard2',
    label: 'Edgeguards Parser',
    tooltip:
      'True edgeguards only: the victim makes a valid recovery attempt in range of the ledge, then the edgeguarder blocks the return (hit or ledge-steal) before the KO. Each clip is tagged with metrics that the Edgeguards Filter can refine.',
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
        name: 'Require Edgeguarder Offstage',
        id: 'requireEdgeguarderCommit',
        type: 'checkbox',
        default: false,
        tooltip:
          'Only keep sequences where the edgeguarder also went past the ledge (committed offstage to gimp).',
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
        default: '600',
        tooltip:
          'Cap how far back from the KO the offstage sequence can start (600 = 10 seconds). Bounds clip length.',
      },
    ],
  },
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
        name: 'Min Score',
        id: 'minScore',
        type: 'int',
        default: '',
        tooltip:
          'Keep edgeguards scoring at least this. Higher = flashier. No hard max, but scores run ~3–40: ~3–5 is a barely-qualifying gimp, 5–15 is typical, and 20+ is a long, deep, or multi-hit sequence (or one where the edgeguarder chased offstage). Built from +3 per hit, +1 per ~30 offstage frames (~½s), +4 if the edgeguarder went offstage, +2 for a ledge-steal, plus horizontal & vertical depth. Empty = no minimum.',
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
        name: 'Edgeguarder Offstage',
        id: 'edgeguarderOffstage',
        type: 'dropdown',
        options: [
          { name: 'Required', id: 'yes' },
          { name: 'Excluded', id: 'no' },
        ],
        default: '',
        tooltip: 'Whether the edgeguarder committed past the ledge to gimp.',
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
    label: 'Output Directory',
    default: '',
    id: 'outputPath',
    type: 'openDirectory',
    category: 'paths',
    tooltip: 'Where recorded video files are saved.',
  },
  {
    label: 'Default Project Directory',
    default: '',
    id: 'defaultProjectDirectory',
    type: 'openDirectory',
    category: 'paths',
    tooltip:
      'Default location for new projects. Leave empty to use ~/Documents/LM Clipper.',
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
    label: 'Shuffle',
    default: false,
    id: 'shuffle',
    type: 'checkbox',
    category: 'general',
    tooltip: 'Randomize the order of clips before playback or recording.',
  },
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
      'Sends anonymous stats to help improve LM Clipper. No personal data is collected.',
    tooltip:
      'Send anonymous usage statistics to help improve LM Clipper. No personal data is collected.',
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
