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
    options: [
      {
        name: 'Stage',
        id: 'stage',
        type: 'dropdown',
        options: legalStages,
        default: '',
      },
      {
        name: 'Char 1',
        id: 'char1',
        type: 'dropdown',
        options: sortedCharacters,
        default: '',
      },
      {
        name: 'Char 2',
        id: 'char2',
        type: 'dropdown',
        options: sortedCharacters,
        default: '',
      },
      {
        name: 'Player 1',
        id: 'player1',
        type: 'textInput',
        default: '',
      },
      {
        name: 'Player 2',
        id: 'player2',
        type: 'textInput',
        default: '',
      },
    ],
  },
  {
    id: 'slpParser',
    label: 'Combo Parser',
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
        default: '100',
      },
      {
        name: 'Comboer Char',
        id: 'comboerChar',
        type: 'dropdown',
        options: sortedCharacters,
        default: '',
      },
      {
        name: 'Comboee Char',
        id: 'comboeeChar',
        type: 'dropdown',
        options: sortedCharacters,
        default: '',
      },
      {
        name: 'Comboer Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: '',
      },
      {
        name: 'Comboee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: '',
      },
      {
        name: 'Did Kill',
        id: 'didKill',
        type: 'checkbox',
        default: true,
      },
    ],
  },
  {
    id: 'comboFilter',
    label: 'Combo Filter',
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
        name: 'Min Damage',
        id: 'minDamage',
        type: 'int',
        default: '',
      },
      {
        name: 'Comboer Char',
        id: 'comboerChar',
        type: 'dropdown',
        options: sortedCharacters,
        default: '',
      },
      {
        name: 'Comboee Char',
        id: 'comboeeChar',
        type: 'dropdown',
        options: sortedCharacters,
        default: '',
      },
      {
        name: 'Comboer Tag',
        id: 'comboerTag',
        type: 'textInput',
        default: '',
      },
      {
        name: 'Comboee Tag',
        id: 'comboeeTag',
        type: 'textInput',
        default: '',
      },
      {
        name: 'Stage',
        id: 'comboStage',
        type: 'dropdown',
        options: legalStages,
        default: '',
      },
      {
        name: 'Did Kill',
        id: 'didKill',
        type: 'checkbox',
        default: true,
      },
      {
        name: 'Exclude ICs',
        id: 'excludeICs',
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
  // {
  //   id: 'edgeguards',
  //   label: 'Edgeguards',
  //   options: [
  //     {
  //       name: 'Max Files',
  //       id: 'maxFiles',
  //       type: 'int',
  //       default: '',
  //     },
  //     {
  //       name: 'Comboer Char',
  //       id: 'comboerChar',
  //       type: 'dropdown',
  //       options: sortedCharacters,
  //       default: '',
  //     },
  //     {
  //       name: 'Comboee Char',
  //       id: 'comboeeChar',
  //       type: 'dropdown',
  //       options: sortedCharacters,
  //       default: '',
  //     },
  //     {
  //       name: 'Comboer Tag',
  //       id: 'comboerTag',
  //       type: 'textInput',
  //       default: '',
  //     },
  //     {
  //       name: 'Comboee Tag',
  //       id: 'comboeeTag',
  //       type: 'textInput',
  //       default: '',
  //     },
  //   ],
  // },
  // {
  //     id: "actionStates",
  //     label: "Action State",
  //     options: [
  //         {
  //             name: "Max Files",
  //             id: "maxFiles",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboer State",
  //             id: "comboerActionState",
  //             type: "dropdown",
  //             options: actionStates,
  //             default: ""
  //         },
  //         {
  //             name: "Comboee State",
  //             id: "comboeeActionState",
  //             type: "dropdown",
  //             options: actionStates,
  //             default: ""
  //         },
  //         {
  //             name: "Comboer X Pos",
  //             id: "comboerXPos",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboer Y Pos",
  //             id: "comboerYPos",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboer Max D",
  //             id: "comboerMaxD",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboee X Pos",
  //             id: "comboeeXpos",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboee Y Pos",
  //             id: "comboeeYpos",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboee Max D",
  //             id: "comboeeMaxD",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboer Char",
  //             id: "comboerChar",
  //             type: "dropdown",
  //             options: sortedCharacters,
  //             default: ""
  //         },
  //         {
  //             name: "Comboee Char",
  //             id: "comboeeChar",
  //             type: "dropdown",
  //             options: sortedCharacters,
  //             default: ""
  //         },
  //         {
  //             name: "Comboer Tag",
  //             id: "comboerTag",
  //             type: "textInput",
  //             default: ""
  //         },
  //         {
  //             name: "Comboee Tag",
  //             id: "comboeeTag",
  //             type: "textInput",
  //             default: ""
  //         }
  //     ]
  // }
  {
    id: 'sort',
    label: 'Sort',
    options: [
      {
        name: 'Sort Function',
        id: 'sortFunction',
        type: 'dropdown',
        options: sortOptions,
        default: '',
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
    id: 'actionStateFilter',
    label: 'Action State',
    options: [
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
      },
      {
        name: 'Start Frame',
        id: 'startFrom',
        type: 'int',
        default: 0,
      },
      {
        name: 'Nth Move',
        id: 'startFromNthMove',
        type: 'int',
        default: 0,
      },
      {
        name: 'Search Range',
        id: 'searchRange',
        type: 'int',
        default: 0,
      },
      {
        name: 'Comboer State',
        id: 'comboerActionState',
        type: 'dropdown',
        options: actionStates,
        default: '',
      },
      {
        name: 'Comboee State',
        id: 'comboeeActionState',
        type: 'dropdown',
        options: actionStates,
        default: '',
      },
      {
        name: 'Exclude',
        id: 'exclude',
        type: 'checkbox',
        default: false,
      },
      // {
      //   name: 'Comboer Y Pos',
      //   id: 'comboerYPos',
      //   type: 'int',
      //   default: '',
      // },
      // {
      //   name: 'Comboer X Pos',
      //   id: 'comboerXPos',
      //   type: 'int',
      //   default: '',
      // },
      // {
      //   name: 'Comboee Y Pos',
      //   id: 'comboeeYPos',
      //   type: 'int',
      //   default: '',
      // },
    ],
  },
  // {
  //   id: 'endOfStock',
  //   label: 'End Of Stock',
  //   options: [
  //     {
  //       name: 'Max Files',
  //       id: 'maxFiles',
  //       type: 'int',
  //       default: '',
  //     },
  //     {
  //       name: 'Comboer Char',
  //       id: 'comboerChar',
  //       type: 'dropdown',
  //       options: sortedCharacters,
  //       default: '',
  //     },
  //     {
  //       name: 'Comboee Char',
  //       id: 'comboeeChar',
  //       type: 'dropdown',
  //       options: sortedCharacters,
  //       default: '',
  //     },
  //     {
  //       name: 'Frame Window',
  //       id: 'frameWindow',
  //       type: 'int',
  //       default: '60',
  //     },
  //   ],
  // },
  {
    id: 'removeStarKOFrames',
    label: 'Cut Star KO',
    options: [
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
      },
    ],
  },
  {
    id: 'reverse',
    label: 'Reverse Hit',
    options: [
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
      },
      {
        name: 'nth Move',
        id: 'n',
        type: 'int',
        default: '',
      },
      {
        name: 'Move type',
        id: 'moveId',
        type: 'dropdown',
        options: moves,
        default: '',
      },
    ],
  },
  {
    id: 'custom',
    label: 'Custom Code',
    options: [
      {
        name: 'N',
        id: 'n',
        type: 'int',
        default: '',
      },
      {
        name: 'X',
        id: 'x',
        type: 'int',
        default: '',
      },
      {
        name: 'Y',
        id: 'y',
        type: 'int',
        default: '',
      },
      {
        name: 'Max Files',
        id: 'maxFiles',
        type: 'int',
        default: '',
      },
    ],
  },
  // {
  //   id: 'comboStats',
  //   label: 'Combo Stats',
  //   options: [
  //     {
  //       name: 'Depth',
  //       id: 'depth',
  //       type: 'int',
  //       default: 0,
  //     },
  //   ],
  // },
  {
    id: 'koDirection',
    label: 'KO Direction',
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
        type: 'dropdown',
        options: deathDirections,
        default: '',
      },
    ],
  },
  // {
  //     id: "stomp",
  //     label: "Stomp",
  //     options: [
  //         {
  //             name: "Move",
  //             id: "move",
  //             type: "dropdown",
  //             options: moves
  //         },
  //     ]
  // }
  // {
  //     id: "scrubbleJump",
  //     label: "Scrubble Jump",
  //     options: []
  // },{
  //     id: "animeFalco",
  //     label: "Anime Falco",
  //     options: []
  // },{
  //     id: "multiverse",
  //     label: "Multi Verse",
  //     options: []
  // },{
  //     id: "alternatingDimensions",
  //     label: "Alternate",
  //     options: []
  // },{
  //     id: "beatsPerMango",
  //     label: "BPM",
  //     options: []
  // },{
  //     id: "zeldaParser",
  //     label: "Zelda Parser",
  //     options: [
  //         {
  //             name: "Min Hits",
  //             id: "minHits",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Max Files",
  //             id: "maxFiles",
  //             type: "int",
  //             default: ""
  //         },
  //         {
  //             name: "Comboee Char",
  //             id: "comboeeChar",
  //             type: "dropdown",
  //             options: sortedCharacters,
  //             default: ""
  //         },
  //         {
  //             name: "Comboer Tag",
  //             id: "comboerTag",
  //             type: "textInput",
  //             default: ""
  //         },
  //         {
  //             name: "Comboee Tag",
  //             id: "comboeeTag",
  //             type: "textInput",
  //             default: ""
  //         },
  //         {
  //             name: "Did Kill",
  //             id: "didKill",
  //             type: "checkbox",
  //             default: false
  //         }
  //     ]
  // }
]

export const videoConfig = [
  {
    label: 'Hide Hud',
    default: false,
    id: 'hideHud',
    type: 'checkbox',
  },
  {
    label: 'Game Music',
    default: false,
    id: 'gameMusic',
    type: 'checkbox',
  },
  {
    label: 'Enable Chants',
    default: false,
    id: 'enableChants',
    type: 'checkbox',
  },
  {
    label: 'No Screen Shake',
    default: false,
    id: 'disableScreenShake',
    type: 'checkbox',
  },
  {
    label: 'Hide Tags',
    default: false,
    id: 'hideTags',
    type: 'checkbox',
  },
  {
    label: 'Hide Netplay Names',
    default: false,
    id: 'hideNames',
    type: 'checkbox',
  },
  // {
  //   label: 'Overlay Source',
  //   default: false,
  //   id: 'overlaySource',
  //   type: 'checkbox',
  // },
  {
    label: 'Fixed Camera',
    default: false,
    id: 'fixedCamera',
    type: 'checkbox',
  },
  {
    label: 'Disable Electric Buzz',
    default: false,
    id: 'noElectricSFX',
    type: 'checkbox',
  },
  {
    label: 'Disable Crowd Noises',
    default: false,
    id: 'noCrowdNoise',
    type: 'checkbox',
  },
  {
    label: 'No Magnifying Glass',
    default: false,
    id: 'disableMagnifyingGlass',
    type: 'checkbox',
  },
  {
    label: 'Shuffle',
    default: false,
    id: 'shuffle',
    type: 'checkbox',
  },
  {
    label: 'Resolution',
    default: '1x',
    id: 'resolution',
    type: 'dropdown',
    options: [
      {
        label: '1x (640x528)',
        value: 2,
      },
      {
        label: '1.5x (960x792)',
        value: 3,
      },
      {
        label: '2x (1280x1056) - 720p',
        value: 4,
      },
      {
        label: '2.5x (1600x1320)',
        value: 5,
      },
      {
        label: '3x (1920x1584) - 1080p',
        value: 6,
      },
      {
        label: '4x (2560x2112)',
        value: 7,
      },
      {
        label: '5x (3200x2640)',
        value: 8,
      },
      {
        label: '6x (3640x3168) - 4K',
        value: 9,
      },
      {
        label: '7x (4480x3696)',
        value: 10,
      },
      {
        label: '8x (5120x4224)',
        value: 11,
      },
    ],
  },
  {
    label: 'Add Start Frames',
    default: 0,
    id: 'addStartFrames',
    type: 'int',
  },
  {
    label: 'Add End Frames',
    default: 0,
    id: 'addEndFrames',
    type: 'int',
  },
  {
    label: 'Final End Frames',
    default: 0,
    id: 'lastClipOffset',
    type: 'int',
  },
  {
    label: 'Bitrate',
    default: 15000,
    id: 'bitrateKbps',
    type: 'textInput',
  },
  {
    label: '# Dolphins',
    default: 1,
    id: 'numCPUs',
    type: 'int',
  },
  {
    label: '# Clips',
    default: 1,
    id: 'slice',
    type: 'int',
  },
  // {
  //   label: 'Dolphin Cutoff',
  //   default: 300,
  //   id: 'dolphinCutoff',
  //   type: 'int',
  // },
  {
    label: 'Melee .iso Path',
    default: '',
    id: 'ssbmIsoPath',
    type: 'openFile',
  },
  {
    label: 'Dolphin Path',
    default: '',
    id: 'dolphinPath',
    type: 'openFile',
  },
  {
    label: 'Output Directory',
    default: '',
    id: 'outputPath',
    type: 'openDirectory',
  },
  {
    label: '# CPU Threads for Filters',
    default: 1,
    id: 'numFilterThreads',
    type: 'int',
  },
]
