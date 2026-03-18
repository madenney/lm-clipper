import { legalStages } from './stages'
import { sortedCharacters } from './characters'
import { moves } from './moves'
import { actionStates } from './actionStates'
import { deathDirections } from './deathDirections'
import { sortOptions } from '../models/methods/sort'

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
      },
      {
        name: 'Player 1',
        id: 'player1',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Player 1 CC',
        id: 'player1CC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Char 2',
        id: 'char2',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
      },
      {
        name: 'Player 2',
        id: 'player2',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Player 2 CC',
        id: 'player2CC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Stage',
        id: 'stage',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
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
      },
      {
        name: 'Max Hits',
        id: 'maxHits',
        type: 'int',
        default: '',
      },
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
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
        name: 'Comboer Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
      },
      {
        name: 'Comboee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
      },
      {
        name: 'Comboer Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Comboer CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Comboee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Comboee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Did Kill',
        id: 'didKill',
        type: 'checkbox',
        default: false,
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
      },
      {
        name: 'Max Hits',
        id: 'maxHits',
        type: 'int',
        default: '',
      },
      {
        name: 'Min Damage',
        id: 'minDamage',
        type: 'int',
        default: '',
      },
      {
        name: 'Comboer Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
      },
      {
        name: 'Comboer Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Comboer CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Comboee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
      },
      {
        name: 'Comboee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Comboee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Stage',
        id: 'comboStage',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
      },
      {
        name: 'Did Kill',
        id: 'didKill',
        type: 'checkbox',
        default: true,
      },
      {
        name: 'Count Pummels',
        id: 'countPummels',
        type: 'checkbox',
        default: false,
      },
      {
        name: 'Nth Moves',
        id: 'nthMoves',
        type: 'nthMoves',
        options: moves,
        default: [],
        moves: [],
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
        name: 'Comboee State',
        id: 'comboeeActionState',
        type: 'multiDropdown',
        options: actionStates,
        default: [],
        tooltip:
          "Filter clips by the defender's action state during the search window. Without a parser, matches any player.",
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
    label: 'Edgeguards',
    tooltip: 'Parse for edgeguard sequences (experimental)',
    options: [
      {
        name: 'Edgeguarder Char',
        id: 'comboerChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
      },
      {
        name: 'Edgeguardee Char',
        id: 'comboeeChar',
        type: 'multiDropdown',
        options: sortedCharacters,
        default: [],
      },
      {
        name: 'Edgeguarder Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Edgeguarder CC',
        id: 'comboerCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Edgeguardee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: [],
        autocomplete: 'names',
      },
      {
        name: 'Edgeguardee CC',
        id: 'comboeeCC',
        type: 'textInput',
        default: [],
        autocomplete: 'connectCodes',
      },
      {
        name: 'Stage',
        id: 'stageFilter',
        type: 'multiDropdown',
        options: legalStages,
        default: [],
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
      },
      {
        name: 'Direction',
        id: 'direction',
        type: 'multiDropdown',
        options: deathDirections,
        default: [],
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
      },
      {
        name: 'Reverse',
        id: 'reverse',
        type: 'checkbox',
        default: false,
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
  },
  {
    label: 'Dolphin Path',
    default: '',
    id: 'dolphinPath',
    type: 'openFile',
    category: 'paths',
  },
  {
    label: 'Output Directory',
    default: '',
    id: 'outputPath',
    type: 'openDirectory',
    category: 'paths',
  },
  {
    label: 'Default Project Directory',
    default: '',
    id: 'defaultProjectDirectory',
    type: 'openDirectory',
    category: 'paths',
  },
  {
    label: 'FFmpeg Path Override',
    default: '',
    id: 'ffmpegPath',
    type: 'openFile',
    category: 'paths',
  },
  // Output
  {
    label: 'Filename Pattern',
    default: '{index}',
    id: 'outputFilenamePattern',
    type: 'textInput',
    category: 'output',
    hint: '{character1}, {character2}, {stage}, {index}, {date}, {time}',
  },
  // Video Output
  {
    label: 'Recording Resolution',
    default: 2,
    id: 'resolution',
    type: 'dropdown',
    category: 'video',
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
    type: 'textInput',
    category: 'video',
  },
  {
    label: 'Add Start Frames',
    default: 0,
    id: 'addStartFrames',
    type: 'int',
    category: 'video',
  },
  {
    label: 'Add End Frames',
    default: 0,
    id: 'addEndFrames',
    type: 'int',
    category: 'video',
  },
  {
    label: 'Final End Frames',
    default: 0,
    id: 'lastClipOffset',
    type: 'int',
    category: 'video',
  },
  {
    label: 'Fullscreen',
    default: true,
    id: 'fullscreen',
    type: 'checkbox',
    category: 'video',
  },
  {
    label: 'Concatenate Output',
    default: false,
    id: 'concatenate',
    type: 'checkbox',
    category: 'video',
  },
  {
    label: 'Convert to MP4',
    default: false,
    id: 'convertToMp4',
    type: 'checkbox',
    category: 'video',
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
  },
  {
    label: 'Clips per Batch',
    default: 1,
    id: 'slice',
    type: 'int',
    category: 'performance',
  },
  {
    label: 'CPU Threads',
    default: 1,
    id: 'numFilterThreads',
    type: 'int',
    category: 'performance',
  },
  // General
  {
    label: 'Shuffle',
    default: false,
    id: 'shuffle',
    type: 'checkbox',
    category: 'general',
  },
  {
    label: 'Detect Duplicates on Import',
    default: false,
    id: 'detectDuplicatesOnImport',
    type: 'checkbox',
    category: 'general',
    warning: 'Can significantly slow down imports with large file counts',
  },
  {
    label: 'Include Default Filters (Parser + Combo Filter)',
    default: true,
    id: 'includeDefaultFilters',
    type: 'checkbox',
    category: 'general',
  },
  {
    label: 'Warn on Parser Delete',
    default: true,
    id: 'warnOnParserDelete',
    type: 'checkbox',
    category: 'general',
  },
  {
    label: 'Advanced Mode',
    default: false,
    id: 'advancedMode',
    type: 'checkbox',
    category: 'general',
  },
  {
    label: 'Test Mode',
    default: false,
    id: 'testMode',
    type: 'checkbox',
    category: 'general',
  },
  {
    label: 'Test Dolphin',
    id: 'testDolphin',
    type: 'button',
    category: 'general',
    buttonLabel: 'Launch Test',
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
