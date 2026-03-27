import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { FiCopy, FiCheck } from 'react-icons/fi'

type SavedTemplate = {
  name: string
  code: string
}

type CustomParam = {
  name: string
  type: string
  value: string
}

type UpstreamField = {
  name: string
  type: string
  from: string
}

type InitData = {
  code: string
  filterName: string
  filterId: string
  savedCustomFilters: SavedTemplate[]
  mode?: 'filter' | 'template'
  templateIndex?: number
  customParams?: CustomParam[]
  outputFields?: { name: string; type: string }[]
  upstreamFields?: UpstreamField[]
  upstreamTypes?: string[]
}

const btnStyle: React.CSSProperties = {
  background: '#45475a',
  color: '#cdd6f4',
  border: 'none',
  borderRadius: 4,
  padding: '3px 10px',
  cursor: 'pointer',
  fontSize: 12,
}

type RefSection = {
  label: string
  description: string
  code: string
  children?: { label: string; description: string; code: string }[]
}

const refSections: RefSection[] = [
  {
    label: 'clips',
    description:
      'Array of clip objects from the previous filter. Return a filtered version of this array.',
    code: `{
  startFrame: number
  endFrame: number
  path: string        // absolute path to the .slp file
  stage: number       // stage ID
  startedAt?: number  // Unix timestamp
  comboer?: {
    playerIndex: number
    port: number
    characterId: number
    characterColor: number
    nametag: string
    displayName: string
    connectCode: string
  }
  comboee?: {         // same shape as comboer
    playerIndex: number
    port: number
    characterId: number
    characterColor: number
    nametag: string
    displayName: string
    connectCode: string
  }
  players?: PlayerInterface[]  // all players in the game
  combo?: {
    startPercent: number
    endPercent: number | null
    didKill: boolean
    moves?: {
      playerIndex: number
      frame: number
      moveId: number
      hitCount: number
      damage: number
    }[]
  }
  // You can add custom properties to clips and they will
  // carry through to subsequent filters in the chain.
  // e.g. clip.myScore = 42
}`,
  },
  {
    label: 'SlippiGame',
    description:
      'The @slippi/slippi-js class. Use new SlippiGame(clip.path) to open a replay.',
    code: `const game = new SlippiGame(clip.path)

game.getSettings()    // → GameStartType | null
game.getMetadata()    // → MetadataType | null
game.getStats()       // → StatsType | null
game.getFrames()      // → { [frameNumber]: FrameEntryType }
game.getLatestFrame() // → FrameEntryType | null`,
    children: [
      {
        label: 'getSettings()',
        description: 'Game start info: stage, players, mode, etc.',
        code: `{
  slpVersion: string | null
  timerType: number | null
  inGameMode: number | null
  isTeams: boolean | null
  stageId: number | null
  startingTimerSeconds: number | null
  itemSpawnBehavior: number | null
  players: {
    playerIndex: number
    port: number
    characterId: number | null
    type: number | null          // 0 = human, 1 = CPU
    startStocks: number | null
    characterColor: number | null
    teamId: number | null
    cpuLevel: number | null
    offenseRatio: number | null
    defenseRatio: number | null
    nametag: string | null
    displayName: string
    connectCode: string
    userId: string
  }[]
  scene: number | null
  gameMode: number | null
  language: number | null
  randomSeed: number | null
  isPAL: boolean | null
  isFrozenPS: boolean | null
  matchInfo: {
    matchId: string | null
    gameNumber: number | null
    tiebreakerNumber: number | null
  } | null
}`,
      },
      {
        label: 'getMetadata()',
        description: 'Replay metadata: timestamps, character usage.',
        code: `{
  startAt?: string | null       // ISO timestamp
  playedOn?: string | null      // e.g. "dolphin" or "network"
  lastFrame?: number | null
  players?: {
    [playerIndex: number]: {
      characters: {
        [internalCharacterId: number]: number  // char → frame count
      }
      names?: {
        netplay?: string | null
        code?: string | null
      }
    }
  } | null
  consoleNick?: string | null
}`,
      },
      {
        label: 'getStats()',
        description:
          'Computed stats: combos, stocks, conversions, action counts.',
        code: `{
  gameComplete: boolean
  lastFrame: number
  playableFrameCount: number
  stocks: {
    playerIndex: number
    count: number
    deathAnimation?: number | null
    startFrame: number
    endFrame?: number | null
    startPercent: number
    currentPercent: number
    endPercent?: number | null
  }[]
  conversions: {
    playerIndex: number
    moves: { playerIndex, frame, moveId, hitCount, damage }[]
    didKill: boolean
    openingType: string
    startFrame: number
    endFrame?: number | null
    startPercent: number
    endPercent?: number | null
  }[]
  combos: {
    playerIndex: number
    moves: { playerIndex, frame, moveId, hitCount, damage }[]
    didKill: boolean
    startFrame: number
    endFrame?: number | null
    startPercent: number
    endPercent?: number | null
  }[]
  actionCounts: {
    playerIndex: number
    wavedashCount: number
    wavelandCount: number
    airDodgeCount: number
    dashDanceCount: number
    spotDodgeCount: number
    ledgegrabCount: number
    rollCount: number
    lCancelCount: { success: number, fail: number }
    grabCount: { success: number, fail: number }
    throwCount: { up, forward, back, down: number }
    groundTechCount: { away, in, neutral, fail: number }
    wallTechCount: { success: number, fail: number }
  }[]
  overall: {
    playerIndex: number
    inputCounts: { buttons, triggers, joystick, cstick, total: number }
    conversionCount: number
    totalDamage: number
    killCount: number
    successfulConversions: { count, total: number, ratio: number | null }
    inputsPerMinute: { count, total: number, ratio: number | null }
    openingsPerKill: { count, total: number, ratio: number | null }
    damagePerOpening: { count, total: number, ratio: number | null }
    neutralWinRatio: { count, total: number, ratio: number | null }
    counterHitRatio: { count, total: number, ratio: number | null }
    beneficialTradeRatio: { count, total: number, ratio: number | null }
  }[]
}`,
      },
      {
        label: 'getFrames()',
        description: 'All frames. Returns { [frameNumber]: FrameEntryType }.',
        code: `// Each frame entry:
{
  frame: number
  players: {
    [playerIndex: number]: {
      pre: {
        frame: number | null
        playerIndex: number | null
        actionStateId: number | null
        positionX: number | null
        positionY: number | null
        facingDirection: number | null
        joystickX: number | null
        joystickY: number | null
        cStickX: number | null
        cStickY: number | null
        trigger: number | null
        buttons: number | null
        physicalButtons: number | null
        physicalLTrigger: number | null
        physicalRTrigger: number | null
        percent: number | null
      }
      post: {
        frame: number | null
        playerIndex: number | null
        internalCharacterId: number | null
        actionStateId: number | null
        positionX: number | null
        positionY: number | null
        facingDirection: number | null
        percent: number | null
        shieldSize: number | null
        lastAttackLanded: number | null
        currentComboCount: number | null
        lastHitBy: number | null
        stocksRemaining: number | null
        actionStateCounter: number | null
        isAirborne: boolean | null
        lastGroundId: number | null
        jumpsRemaining: number | null
        lCancelStatus: number | null
        hurtboxCollisionState: number | null
        hitlagRemaining: number | null
        animationIndex: number | null
      }
    } | null
  }
  followers: {
    [playerIndex: number]: { pre, post } | null  // Ice Climbers Nana
  }
  items?: {
    typeId: number | null
    state: number | null
    positionX: number | null
    positionY: number | null
    velocityX: number | null
    velocityY: number | null
    owner: number | null
    spawnId: number | null
  }[]
}`,
      },
      {
        label: 'getLatestFrame()',
        description:
          'The last frame of the game. Same shape as a single frame from getFrames().',
        code: `// Same as a single frame entry from getFrames()
// See getFrames() above for the full shape.`,
      },
    ],
  },
]

const buildParamsSection = (customParams?: CustomParam[]): RefSection => {
  const lines = [
    '  code: string      // the code you wrote (this code)',
    '  maxFiles: string  // max files limit (from filter options)',
  ]
  if (customParams && customParams.length > 0) {
    customParams.forEach((cp) => {
      if (!cp.name) return
      if (cp.type === 'int') {
        lines.push(`  ${cp.name}: number      // = ${cp.value || '0'}`)
      } else if (cp.type === 'array') {
        const arr = (cp.value || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        lines.push(`  ${cp.name}: string[]   // = ${JSON.stringify(arr)}`)
      } else {
        lines.push(
          `  ${cp.name}: string      // = ${JSON.stringify(cp.value || '')}`,
        )
      }
    })
  }
  return {
    label: 'params',
    description:
      "This filter's params object. Contains built-in options plus any custom parameters you define on the filter card.",
    code: `{\n${lines.join('\n')}\n}`,
  }
}

const aiPrompt = `You are writing a JavaScript code block for "LM Clipper" (https://github.com/madenney/lm-clipper), a desktop app that automates clip generation from Super Smash Bros. Melee replay files (.slp files parsed by the Slippi project).

The app imports .slp replay files, lets users build a filter chain (game filter → combo parser → combo filter → custom code → sort), and generates video clips from the results using Slippi Dolphin + ffmpeg.

I'm writing a "Custom Code" filter. This filter receives the output of previous filters and must return a filtered/transformed array of clips. The code I write is executed as the body of a function with these three parameters:

## 1. \`clips\` — Array of clip objects from the previous filter

Each clip has this shape:
\`\`\`
{
  startFrame: number
  endFrame: number
  path: string        // absolute path to the .slp replay file
  stage: number       // stage ID (e.g. 2 = Fountain of Dreams, 3 = Pokemon Stadium, 8 = Yoshi's Story, 31 = Battlefield, 32 = Final Destination)
  startedAt?: number  // Unix timestamp of when the game started
  comboer?: {         // the player who performed the combo
    playerIndex: number
    port: number
    characterId: number   // internal Melee character ID
    characterColor: number
    nametag: string
    displayName: string
    connectCode: string   // Slippi online connect code e.g. "ABC#123"
  }
  comboee?: {         // the player who received the combo (same shape as comboer)
    playerIndex: number
    port: number
    characterId: number
    characterColor: number
    nametag: string
    displayName: string
    connectCode: string
  }
  players?: PlayerInterface[]  // all players in the game
  combo?: {
    startPercent: number
    endPercent: number | null
    didKill: boolean
    moves?: {
      playerIndex: number
      frame: number
      moveId: number      // Melee move ID (e.g. 2=jab, 7=ftilt, 10=nair, etc.)
      hitCount: number
      damage: number
    }[]
  }
  // You can add custom properties to clips (e.g. clip.myScore = 42)
  // and they will carry through to subsequent filters in the chain.
}
\`\`\`

## 2. \`SlippiGame\` — The @slippi/slippi-js class

Use it to open any replay file and access detailed frame data, stats, settings, and metadata:
\`\`\`js
const game = new SlippiGame(clip.path)
game.getSettings()    // → game start info: stageId, players[], isTeams, isPAL, matchInfo, etc.
game.getMetadata()    // → { startAt, lastFrame, players: { [idx]: { characters, names } }, consoleNick }
game.getStats()       // → { stocks[], conversions[], combos[], actionCounts[], overall[] }
                      //   actionCounts has: wavedashCount, dashDanceCount, lCancelCount, grabCount, etc.
                      //   overall has: inputsPerMinute, neutralWinRatio, damagePerOpening, killCount, etc.
game.getFrames()      // → { [frameNumber]: { players: { [idx]: { pre, post } }, followers, items? } }
                      //   pre: joystick/cstick/buttons/trigger inputs, actionStateId, position, percent
                      //   post: actionStateId, position, percent, shieldSize, stocksRemaining, isAirborne, etc.
game.getLatestFrame() // → last frame (same shape as single frame from getFrames)
\`\`\`

## 3. \`params\` — This filter's params object
\`\`\`
{ code: string, maxFiles: string, ...customParams }
\`\`\`
Users can define custom parameters (int, string, array) on the filter card. These are flattened onto params as top-level keys. Int params are parsed to numbers, string params are strings, array params are comma-separated strings split into string arrays.
CUSTOM_PARAMS_PLACEHOLDER
## What I need to return

The code must return an array of clip objects (same shape as the input). Typically you filter the \`clips\` array, but you can also modify clip properties (e.g. adjust startFrame/endFrame) or create new clips. You can also add custom properties to clips (e.g. \`clip.myScore = 42\`) and they will carry through to subsequent filters in the chain.

## Example

\`\`\`js
// Keep only combos that killed and had at least 4 moves
return clips.filter(clip => {
  return clip.combo && clip.combo.didKill && clip.combo.moves && clip.combo.moves.length >= 4
})
\`\`\`

---

Please write a Custom Code filter block that does the following:
[DESCRIBE WHAT YOU WANT HERE]`

const buildAiPrompt = (
  customParams?: CustomParam[],
  upstreamFields?: UpstreamField[],
): string => {
  let result = aiPrompt
  if (!customParams || customParams.filter((p) => p.name).length === 0) {
    result = result.replace('CUSTOM_PARAMS_PLACEHOLDER\n', '')
  } else {
    const lines = customParams
      .filter((p) => p.name)
      .map((p) => {
        if (p.type === 'int') {
          return `- \`params.${p.name}\`: number (current value: ${p.value || '0'})`
        }
        if (p.type === 'array') {
          const arr = (p.value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          return `- \`params.${p.name}\`: string[] (current value: ${JSON.stringify(arr)})`
        }
        return `- \`params.${p.name}\`: string (current value: ${JSON.stringify(p.value || '')})`
      })
    const block = `\nThis filter has the following custom parameters defined:\n${lines.join('\n')}\n`
    result = result.replace('CUSTOM_PARAMS_PLACEHOLDER\n', block)
  }
  if (upstreamFields && upstreamFields.length > 0) {
    const fieldLines = upstreamFields
      .map((f) => `- \`clip.${f.name}\`: ${f.type} (added by "${f.from}")`)
      .join('\n')
    result += `\n\nPrevious filters in the chain have added these custom fields to each clip:\n${fieldLines}\nYou can read these fields on each clip object.`
  }
  return result
}

const toggleStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: '#89b4fa',
  userSelect: 'none',
  display: 'inline',
  marginRight: 4,
}

function findJsonAttr(node: Node | null): string | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : node?.parentElement || null
  while (el) {
    if (el.dataset?.json) return el.dataset.json
    el = el.parentElement
  }
  return null
}

function handleConsoleCopy(e: React.ClipboardEvent) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)

  const consoleDiv = e.currentTarget as HTMLElement
  // Find all copyable entries (object fields + array items)
  const allEntries = Array.from(
    consoleDiv.querySelectorAll('[data-json-field],[data-json-item]'),
  ) as HTMLElement[]

  if (allEntries.length > 0) {
    const selRects = range.getClientRects()
    if (selRects.length > 0) {
      let selTop = Infinity
      let selBottom = -Infinity
      for (let i = 0; i < selRects.length; i++) {
        selTop = Math.min(selTop, selRects[i].top)
        selBottom = Math.max(selBottom, selRects[i].bottom)
      }

      let selected = allEntries.filter((el) => {
        const r = el.getBoundingClientRect()
        return r.bottom > selTop + 2 && r.top < selBottom - 2
      })

      // Remove ancestors: if an element contains another selected element, drop it
      selected = selected.filter(
        (el) => !selected.some((other) => other !== el && el.contains(other)),
      )

      if (selected.length > 0 && selected.length < allEntries.length) {
        e.preventDefault()
        // Check if all selected are object fields (merge into one object)
        const allFields = selected.every((el) => el.dataset.jsonField)
        if (allFields) {
          const merged: Record<string, any> = {}
          for (const el of selected) {
            try {
              const obj = JSON.parse(el.dataset.jsonField!)
              Object.assign(merged, obj)
            } catch {
              /* skip */
            }
          }
          e.clipboardData.setData('text/plain', JSON.stringify(merged, null, 2))
        } else {
          // Array items or mixed — collect as array
          const items = selected.map((el) => {
            const raw = el.dataset.jsonItem || el.dataset.jsonField
            try {
              return JSON.parse(raw!)
            } catch {
              return null
            }
          })
          const result = items.length === 1 ? items[0] : items
          e.clipboardData.setData('text/plain', JSON.stringify(result, null, 2))
        }
        return
      }
    }
  }

  // Fallback: find tightest data-json container
  const json =
    findJsonAttr(range.startContainer) ||
    findJsonAttr(range.commonAncestorContainer)
  if (json) {
    e.preventDefault()
    e.clipboardData.setData('text/plain', json)
  }
}

function JsonValue({ value, depth = 0 }: { value: any; depth?: number }) {
  const [open, setOpen] = useState(false)
  const jsonStr = useMemo(() => JSON.stringify(value, null, 2), [value])

  if (value === null) return <span style={{ color: '#7f849c' }}>null</span>
  if (value === undefined)
    return <span style={{ color: '#7f849c' }}>undefined</span>
  if (typeof value === 'boolean')
    return <span style={{ color: '#fab387' }}>{String(value)}</span>
  if (typeof value === 'number')
    return <span style={{ color: '#fab387' }}>{value}</span>
  if (typeof value === 'string')
    return (
      <span style={{ color: '#a6e3a1' }}>
        &quot;{value.length > 200 ? `${value.slice(0, 200)}...` : value}&quot;
      </span>
    )

  if (Array.isArray(value)) {
    if (value.length === 0) return <span style={{ color: '#7f849c' }}>[]</span>
    if (!open) {
      return (
        <span
          data-json={jsonStr}
          onClick={(e) => {
            if (window.getSelection()?.type === 'Range') return
            e.stopPropagation()
            setOpen(true)
          }}
          style={{ cursor: 'pointer' }}
        >
          <span style={toggleStyle}>{'\u25B6'}</span>
          <span
            style={{
              color: '#7f849c',
              display: 'inline-block',
              maxWidth: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'bottom',
            }}
          >
            Array({value.length})
          </span>
        </span>
      )
    }
    return (
      <span data-json={jsonStr}>
        <span
          onClick={(e) => {
            if (window.getSelection()?.type === 'Range') return
            e.stopPropagation()
            setOpen(false)
          }}
          style={{ cursor: 'pointer' }}
        >
          <span style={toggleStyle}>{'\u25BC'}</span>
          <span style={{ color: '#7f849c' }}>Array({value.length})</span>
        </span>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            paddingLeft: 16,
            borderLeft: '1px solid #313244',
            cursor: 'default',
          }}
        >
          {value.map((item, i) => (
            <div
              key={i}
              data-json-item={JSON.stringify(item)}
              style={{ marginTop: 1 }}
            >
              <span style={{ color: '#7f849c', marginRight: 6 }}>{i}:</span>
              <JsonValue value={item} depth={depth + 1} />
            </div>
          ))}
        </div>
      </span>
    )
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0)
      return <span style={{ color: '#7f849c' }}>{'{}'}</span>
    const preview = keys.slice(0, 3).join(', ')
    if (!open) {
      return (
        <span
          data-json={jsonStr}
          onClick={(e) => {
            if (window.getSelection()?.type === 'Range') return
            e.stopPropagation()
            setOpen(true)
          }}
          style={{ cursor: 'pointer' }}
        >
          <span style={toggleStyle}>{'\u25B6'}</span>
          <span style={{ color: '#7f849c' }}>
            {'{'} {preview}
            {keys.length > 3 ? ', ...' : ''} {'}'}
          </span>
        </span>
      )
    }
    return (
      <span data-json={jsonStr}>
        <span
          onClick={(e) => {
            if (window.getSelection()?.type === 'Range') return
            e.stopPropagation()
            setOpen(false)
          }}
          style={{ cursor: 'pointer' }}
        >
          <span style={toggleStyle}>{'\u25BC'}</span>
          <span style={{ color: '#7f849c' }}>
            {'{'} {preview}
            {keys.length > 3 ? ', ...' : ''} {'}'}
          </span>
        </span>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            paddingLeft: 16,
            borderLeft: '1px solid #313244',
            cursor: 'default',
          }}
        >
          {keys.map((k) => (
            <div
              key={k}
              data-json-field={JSON.stringify({ [k]: value[k] })}
              style={{ marginTop: 1 }}
            >
              <span style={{ color: '#cba6f7', marginRight: 6 }}>{k}:</span>
              <JsonValue value={value[k]} depth={depth + 1} />
            </div>
          ))}
        </div>
      </span>
    )
  }

  return <span style={{ color: '#cdd6f4' }}>{String(value)}</span>
}

function ConsoleEntry({ label, data }: { label: string; data: any[] }) {
  const [open, setOpen] = useState(false)
  const jsonStr = useMemo(() => JSON.stringify(data, null, 2), [data])
  return (
    <div style={{ marginTop: 4 }} data-json={jsonStr}>
      <span
        onClick={(e) => {
          if (window.getSelection()?.type === 'Range') return
          e.stopPropagation()
          setOpen(!open)
        }}
        style={{ cursor: 'pointer' }}
      >
        <span style={toggleStyle}>{open ? '\u25BC' : '\u25B6'}</span>
        <span style={{ color: '#cdd6f4' }}>{label}</span>
        <span style={{ color: '#7f849c' }}> ({data.length})</span>
      </span>
      {open && (
        <div style={{ paddingLeft: 12, marginTop: 2 }}>
          {data.map((item, i) => (
            <div
              key={i}
              data-json-item={JSON.stringify(item)}
              style={{
                marginTop: 2,
                paddingTop: 2,
                borderTop: i > 0 ? '1px solid #1e2030' : 'none',
              }}
            >
              <span style={{ color: '#7f849c', marginRight: 6 }}>[{i}]</span>
              <JsonValue value={item} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CodeEditorPage() {
  const [initData, setInitData] = useState<InitData | null>(null)
  const [dirty, setDirty] = useState(false)
  const [showSaved, setShowSaved] = useState(false)
  const [templates, setTemplates] = useState<SavedTemplate[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState(-1)
  const [tmplDropOpen, setTmplDropOpen] = useState(false)
  const tmplDropRef = useRef<HTMLDivElement>(null)
  const [fontSize, setFontSize] = useState(14)
  const [showRef, setShowRef] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [expandedRef, setExpandedRef] = useState<Set<string>>(new Set())
  const [testOutput, setTestOutput] = useState<{
    logs: string[]
    inputClips?: any[]
    outputClips?: any[]
    inputCount?: number
    outputCount?: number
    error?: string
  } | null>({ logs: [] })
  const [testRunning, setTestRunning] = useState(false)
  const [testSampleSize, setTestSampleSize] = useState(5)
  const [consoleHeight, setConsoleHeight] = useState(200)
  const [consoleCopied, setConsoleCopied] = useState(false)
  const consoleEndRef = useRef<HTMLDivElement>(null)
  const consoleDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const [templateNamePrompt, setTemplateNamePrompt] = useState<string | null>(
    null,
  )
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string
    onYes: () => void
  } | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const savedCodeRef = useRef('')

  const effectiveRefSections = useMemo(() => {
    const clipsSection = { ...refSections[0] }
    const upstream = initData?.upstreamFields
    if (upstream && upstream.length > 0) {
      const fieldLines = upstream
        .map((f) => `  ${f.name}: ${f.type}  // from "${f.from}"`)
        .join('\n')
      clipsSection.code = clipsSection.code.replace(
        /\n}$/,
        `\n  // --- fields from previous filters ---\n${fieldLines}\n}`,
      )
    }
    return [
      clipsSection,
      buildParamsSection(initData?.customParams),
      refSections[1],
    ]
  }, [initData?.customParams, initData?.upstreamFields])

  const dirtyRef = useRef(false)
  const initDataRef = useRef<InitData | null>(null)

  // Close template dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        tmplDropRef.current &&
        !tmplDropRef.current.contains(e.target as Node)
      ) {
        setTmplDropOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Keep refs in sync
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  useEffect(() => {
    initDataRef.current = initData
  }, [initData])

  useEffect(() => {
    if (!editorContainerRef.current) return

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          highlightSelectionMatches(),
          javascript(),
          oneDark,
          EditorView.lineWrapping,
          keymap.of([
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const current = update.state.doc.toString()
              setDirty(current !== savedCodeRef.current)
            }
          }),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
          }),
        ],
      }),
      parent: editorContainerRef.current,
    })

    editorViewRef.current = view
    return () => view.destroy()
  }, [])

  useEffect(() => {
    const remove = window.electron.ipcRenderer.on(
      'code-editor-init',
      (data: InitData) => {
        setInitData(data)
        const tmpls = data.savedCustomFilters || []
        setTemplates(tmpls)
        // Auto-select template if code matches
        const matchIdx = tmpls.findIndex(
          (t) => t.code.trim() === data.code.trim(),
        )
        setSelectedTemplate(matchIdx)
        savedCodeRef.current = data.code
        setDirty(false)

        const view = editorViewRef.current
        if (view) {
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: data.code,
            },
          })
          view.focus()
        }
      },
    )
    window.electron.ipcRenderer.sendMessage('code-editor-ready', {})
    return remove
  }, [])

  // Listen for template list updates from main
  useEffect(() => {
    const remove = window.electron.ipcRenderer.on(
      'code-editor-templates-updated',
      (updated: SavedTemplate[]) => {
        setTemplates(updated || [])
        setSelectedTemplate(-1)
      },
    )
    return remove
  }, [])

  // Auto-scroll console to bottom
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView()
  }, [testOutput])

  // Listen for test run results
  useEffect(() => {
    const remove = window.electron.ipcRenderer.on(
      'code-editor-test-result',
      (result: {
        logs?: string[]
        inputClips?: any[]
        outputClips?: any[]
        inputCount?: number
        outputCount?: number
        error?: string
      }) => {
        setTestRunning(false)
        if (result.error) {
          setTestOutput({
            logs: [`Error: ${result.error}`],
            error: result.error,
          })
        } else {
          setTestOutput({
            logs: result.logs || [],
            inputClips: result.inputClips,
            outputClips: result.outputClips,
            inputCount: result.inputCount,
            outputCount: result.outputCount,
          })
        }
      },
    )
    return remove
  }, [])

  const testRun = useCallback(() => {
    const view = editorViewRef.current
    const data = initDataRef.current
    if (!view || !data) return
    const code = view.state.doc.toString()
    setTestRunning(true)
    setTestOutput({ logs: ['Running...'] })
    window.electron.ipcRenderer.sendMessage('code-editor-test-run', {
      code,
      customParams: data.customParams,
      sampleSize: testSampleSize,
    })
  }, [testSampleSize])

  const setEditorContent = useCallback((code: string) => {
    const view = editorViewRef.current
    if (view) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
      })
      view.focus()
    }
  }, [])

  const save = useCallback(() => {
    const data = initDataRef.current
    if (!data || !editorViewRef.current) return
    const code = editorViewRef.current.state.doc.toString()

    if (data.mode === 'template' && typeof data.templateIndex === 'number') {
      // Template edit mode — save back to template in config
      window.electron.ipcRenderer.sendMessage('code-editor-save', {
        code,
        filterId: '',
        mode: 'template',
        templateIndex: data.templateIndex,
      })
    } else {
      // Filter mode — save to filter
      window.electron.ipcRenderer.sendMessage('code-editor-save', {
        code,
        filterId: data.filterId,
      })
    }

    savedCodeRef.current = code
    setDirty(false)
    setShowSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setShowSaved(false), 1200)
  }, [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        save()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setFontSize((s) => Math.min(s + 2, 32))
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        setFontSize((s) => Math.max(s - 2, 8))
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault()
        setFontSize(14)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [save])

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  const handleClose = () => {
    window.electron.ipcRenderer.sendMessage('code-editor-close')
  }

  const loadTemplate = useCallback(
    (index?: number) => {
      const idx = index ?? selectedTemplate
      if (idx < 0 || idx >= templates.length) return
      const tmpl = templates[idx]
      const doLoad = () => {
        setEditorContent(tmpl.code)
        savedCodeRef.current = tmpl.code
        setDirty(false)
      }
      if (dirtyRef.current) {
        setPendingConfirm({
          message:
            'You have unsaved changes. Load template and discard changes?',
          onYes: doLoad,
        })
      } else {
        doLoad()
      }
    },
    [selectedTemplate, templates, setEditorContent],
  )

  const commitSaveTemplate = useCallback(
    (name: string) => {
      if (!editorViewRef.current || !name.trim()) return
      const code = editorViewRef.current.state.doc.toString()
      if (!code.trim()) return
      const trimmed = name.trim()
      const existing = templates.find((t) => t.name === trimmed)
      const doSave = () => {
        window.electron.ipcRenderer.sendMessage('code-editor-save-template', {
          name: trimmed,
          code,
        })
        setTemplateNamePrompt(null)
      }
      if (existing) {
        setPendingConfirm({
          message: `Template "${trimmed}" already exists. Overwrite it?`,
          onYes: doSave,
        })
      } else {
        doSave()
      }
    },
    [templates],
  )

  const saveAsTemplate = useCallback(() => {
    if (!editorViewRef.current) return
    const code = editorViewRef.current.state.doc.toString()
    if (!code.trim()) return
    setTemplateNamePrompt(initData?.filterName || '')
  }, [initData?.filterName])

  const deleteTemplate = useCallback(() => {
    if (selectedTemplate < 0 || selectedTemplate >= templates.length) return
    const tmpl = templates[selectedTemplate]
    setPendingConfirm({
      message: `Delete template "${tmpl.name}"?`,
      onYes: () => {
        window.electron.ipcRenderer.sendMessage(
          'code-editor-delete-template',
          selectedTemplate,
        )
        setPendingConfirm(null)
      },
    })
  }, [selectedTemplate, templates])

  const copyRefCode = useCallback((key: string, code: string) => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1200)
    })
  }, [])

  const toggleRefExpand = useCallback((key: string) => {
    setExpandedRef((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const isTemplateMode = initData?.mode === 'template'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#1e1e2e',
        color: '#cdd6f4',
      }}
    >
      {/* Scrollbar styles + kill body margin to prevent micro-scroll */}
      <style>{`
        html, body { margin: 0; padding: 0; overflow: hidden; height: 100%; }
        *::-webkit-scrollbar { width: 5px; height: 5px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
        *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
      `}</style>
      {/* Header bar — merged title + templates + save/close */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 16px',
          borderBottom: '1px solid #333',
          flexShrink: 0,
          gap: 8,
          WebkitAppRegion: 'drag',
        }}
      >
        {/* Left: filter/template name + code reference */}
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {initData?.filterName || 'Code Editor'}
        </span>
        <button
          type="button"
          onClick={() => setShowRef((v) => !v)}
          title="Show/hide API reference for clips, SlippiGame, and params"
          style={{
            ...btnStyle,
            background: showRef ? '#585b70' : '#45475a',
            padding: '3px 10px',
            fontSize: 12,
            WebkitAppRegion: 'no-drag',
          }}
        >
          Code Reference
        </button>

        {/* Middle: template controls */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            WebkitAppRegion: 'no-drag',
          }}
        >
          <div
            ref={tmplDropRef}
            style={{ position: 'relative', minWidth: 140 }}
          >
            <button
              type="button"
              onClick={() => setTmplDropOpen((v) => !v)}
              style={{
                background: '#313244',
                color: '#cdd6f4',
                border: '1px solid #45475a',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 12,
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {selectedTemplate >= 0 && templates[selectedTemplate]
                ? templates[selectedTemplate].name
                : templates.length === 0
                  ? 'No saved templates'
                  : 'Select template...'}
            </button>
            {tmplDropOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 2,
                  background: '#1e1e2e',
                  border: '1px solid #45475a',
                  borderRadius: 4,
                  minWidth: '100%',
                  maxHeight: 'calc(100vh - 80px)',
                  overflowY: 'auto',
                  zIndex: 50,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
                }}
              >
                {templates.map((t, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      setSelectedTemplate(i)
                      loadTemplate(i)
                      setTmplDropOpen(false)
                    }}
                    style={{
                      padding: '5px 8px',
                      fontSize: 12,
                      cursor: 'pointer',
                      color: '#cdd6f4',
                      background:
                        i === selectedTemplate
                          ? 'rgba(74, 144, 217, 0.2)'
                          : 'transparent',
                      borderLeft:
                        i === selectedTemplate
                          ? '2px solid #4a90d9'
                          : '2px solid transparent',
                      whiteSpace: 'nowrap',
                    }}
                    onMouseEnter={(e) => {
                      if (i !== selectedTemplate) {
                        ;(e.currentTarget as HTMLDivElement).style.background =
                          'rgba(255,255,255,0.06)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      ;(e.currentTarget as HTMLDivElement).style.background =
                        i === selectedTemplate
                          ? 'rgba(74, 144, 217, 0.2)'
                          : 'transparent'
                    }}
                  >
                    {t.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          {!isTemplateMode && (
            <button
              type="button"
              onClick={saveAsTemplate}
              title="Save code as a reusable template available across all projects"
              style={btnStyle}
            >
              Save Template
            </button>
          )}
          <button
            type="button"
            onClick={deleteTemplate}
            disabled={selectedTemplate < 0}
            title="Delete selected template"
            style={{
              ...btnStyle,
              opacity: selectedTemplate < 0 ? 0.4 : 1,
              cursor: selectedTemplate < 0 ? 'default' : 'pointer',
            }}
          >
            Delete
          </button>
        </div>

        {/* Right: save + close + help */}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            WebkitAppRegion: 'no-drag',
          }}
        >
          {!isTemplateMode && (
            <>
              <button
                type="button"
                onClick={testRun}
                disabled={testRunning}
                title="Run code on a sample of clips from the previous filter"
                style={{
                  background: testRunning ? '#f9e2af' : '#45475a',
                  color: testRunning ? '#1e1e2e' : '#cdd6f4',
                  border: 'none',
                  borderRadius: 4,
                  padding: '4px 14px',
                  cursor: testRunning ? 'wait' : 'pointer',
                  fontSize: 13,
                }}
              >
                {testRunning ? 'Running...' : 'Test Run'}
              </button>
              <span
                style={{ color: '#7f849c', fontSize: 12, lineHeight: '24px' }}
              >
                on
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={testSampleSize}
                onChange={(ev) => {
                  const n = parseInt(ev.target.value, 10)
                  if (!Number.isNaN(n) && n > 0) setTestSampleSize(n)
                }}
                title="Number of results from previous filter to test on"
                style={{
                  width: 48,
                  background: '#1e1e2e',
                  color: '#cdd6f4',
                  border: '1px solid #45475a',
                  borderRadius: 4,
                  padding: '3px 6px',
                  fontSize: 12,
                  textAlign: 'center',
                  MozAppearance: 'textfield',
                }}
              />
              <span
                style={{
                  color: '#7f849c',
                  fontSize: 12,
                  lineHeight: '24px',
                  marginRight: 8,
                }}
              >
                clips
              </span>
            </>
          )}
          <button
            type="button"
            onClick={save}
            title={
              isTemplateMode
                ? 'Save code to this template (Ctrl+S)'
                : 'Save code to this filter (Ctrl+S)'
            }
            style={{
              background: showSaved ? '#a6e3a1' : dirty ? '#89b4fa' : '#45475a',
              color: showSaved || dirty ? '#1e1e2e' : '#cdd6f4',
              border: 'none',
              borderRadius: 4,
              padding: '4px 14px',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: showSaved || dirty ? 600 : 400,
              transition: 'background 0.3s, color 0.3s',
            }}
          >
            {showSaved ? 'Saved!' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleClose}
            style={{
              background: '#45475a',
              color: '#cdd6f4',
              border: 'none',
              borderRadius: 4,
              padding: '4px 14px',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            title="Help"
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: '1px solid #585b70',
              background: 'transparent',
              color: '#7f849c',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ?
          </button>
        </div>
      </div>

      {/* Help modal */}
      {showHelp && (
        <div
          onClick={() => setShowHelp(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1e1e2e',
              border: '1px solid #45475a',
              borderRadius: 10,
              padding: '24px 28px',
              maxWidth: 560,
              width: '90%',
              maxHeight: '80vh',
              overflowY: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
              color: '#cdd6f4',
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <span style={{ fontSize: 18, fontWeight: 600 }}>
                Custom Code Filter
              </span>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#7f849c',
                  fontSize: 20,
                  cursor: 'pointer',
                  padding: '0 4px',
                }}
              >
                &times;
              </button>
            </div>
            <p style={{ margin: '0 0 12px', color: '#bac2de' }}>
              This editor lets you write JavaScript to filter clips however you
              want. Your code receives an array of clips from the previous
              filter and must return the clips you want to keep.
            </p>
            <p
              style={{
                margin: '0 0 12px',
                fontWeight: 600,
                color: '#cdd6f4',
              }}
            >
              How it works:
            </p>
            <ul
              style={{
                margin: '0 0 12px',
                paddingLeft: 20,
                color: '#bac2de',
              }}
            >
              <li>
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  clips
                </code>{' '}
                is an array of clip objects. Each clip has properties like{' '}
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  path
                </code>
                ,{' '}
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  startFrame
                </code>
                ,{' '}
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  endFrame
                </code>
                , character/player info, and combo data if a parser ran before
                this filter.
              </li>
              <li>
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  SlippiGame
                </code>{' '}
                is the slippi-js class. Use{' '}
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  new SlippiGame(clip.path)
                </code>{' '}
                to open a replay and read frame data, metadata, etc.
              </li>
              <li>
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  params
                </code>{' '}
                contains any custom parameters you define below the editor (Max
                Files, or your own).
              </li>
              <li>
                Your code must{' '}
                <code
                  style={{
                    background: '#313244',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 13,
                  }}
                >
                  return
                </code>{' '}
                an array of clips to keep. Return fewer clips to filter, or
                return modified clips to transform data.
              </li>
            </ul>
            <p
              style={{
                margin: '0 0 12px',
                fontWeight: 600,
                color: '#cdd6f4',
              }}
            >
              Tips:
            </p>
            <ul style={{ margin: 0, paddingLeft: 20, color: '#bac2de' }}>
              <li>
                Click <b>Code Reference</b> in the toolbar to see the full shape
                of clip objects and all available fields.
              </li>
              <li>
                Use <b>Test Run</b> to try your code on a small sample before
                running the full filter.
              </li>
              <li>
                Use <b>console.log()</b> in your code to inspect data — output
                appears in the console panel below the editor.
              </li>
              <li>
                Save reusable code as a <b>Template</b> to use it across
                projects.
              </li>
              <li>
                <b>Ctrl+S</b> saves, <b>Ctrl+/Cmd+ +/-</b> adjusts font size.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* Reference panel */}
      {showRef && (
        <div
          style={{
            borderBottom: '1px solid #333',
            background: '#181825',
            overflowY: 'auto',
            maxHeight: '45vh',
            flexShrink: 0,
            padding: '10px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            fontSize: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            {(() => {
              const hasParser = initData?.upstreamTypes?.includes('slpParser')
              const upstream =
                initData?.upstreamFields?.filter((f) => f.name) || []
              const lines: string[] = [
                'const { startFrame, endFrame, path, stage, startedAt, players } = clip',
              ]
              if (hasParser) {
                lines.push('const { combo, comboer, comboee } = clip')
              }
              if (upstream.length > 0) {
                const destructure = upstream.map((f) => f.name).join(', ')
                lines.push(
                  `const { ${destructure} } = clip // from previous filters`,
                )
              }
              const snippet = `clips.forEach(clip => {\n${lines.map((l) => `  ${l}`).join('\n')}\n})`
              return (
                <button
                  type="button"
                  onClick={() => copyRefCode('input', snippet)}
                  title="Copy a snippet that destructures the expected input fields from each clip"
                  style={{
                    ...btnStyle,
                    fontSize: 11,
                    padding: '2px 8px',
                    background: copiedKey === 'input' ? '#a6e3a1' : '#45475a',
                    color: copiedKey === 'input' ? '#1e1e2e' : '#cdd6f4',
                    transition: 'background 0.2s, color 0.2s',
                  }}
                >
                  {copiedKey === 'input' ? 'Copied!' : 'Copy Input Snippet'}
                </button>
              )
            })()}
            {initData?.outputFields &&
              initData.outputFields.filter((f) => f.name).length > 0 &&
              (() => {
                const defaults: Record<string, string> = {
                  number: '0',
                  string: "''",
                  boolean: 'false',
                  array: '[]',
                  object: '{}',
                }
                const fields = initData.outputFields.filter((f) => f.name)
                const assignments = fields
                  .map(
                    (f) => `  clip.${f.name} = ${defaults[f.type] || 'null'}`,
                  )
                  .join('\n')
                const snippet = `clips.forEach(clip => {\n${assignments}\n})`
                return (
                  <button
                    type="button"
                    onClick={() => copyRefCode('output', snippet)}
                    title="Copy a snippet that sets your output fields on each clip"
                    style={{
                      ...btnStyle,
                      fontSize: 11,
                      padding: '2px 8px',
                      background:
                        copiedKey === 'output' ? '#a6e3a1' : '#45475a',
                      color: copiedKey === 'output' ? '#1e1e2e' : '#cdd6f4',
                      transition: 'background 0.2s, color 0.2s',
                    }}
                  >
                    {copiedKey === 'output' ? 'Copied!' : 'Copy Output Snippet'}
                  </button>
                )
              })()}
            <button
              type="button"
              onClick={() =>
                copyRefCode(
                  'ai',
                  buildAiPrompt(
                    initData?.customParams,
                    initData?.upstreamFields,
                  ),
                )
              }
              title="Copy an AI-ready prompt explaining this project and the custom code API — paste into ChatGPT/Claude and describe what you want"
              style={{
                ...btnStyle,
                fontSize: 11,
                padding: '2px 8px',
                background: copiedKey === 'ai' ? '#a6e3a1' : '#45475a',
                color: copiedKey === 'ai' ? '#1e1e2e' : '#cdd6f4',
                transition: 'background 0.2s, color 0.2s',
              }}
            >
              {copiedKey === 'ai' ? 'Copied!' : 'Copy AI Prompt'}
            </button>
            <button
              type="button"
              onClick={() => {
                const all = effectiveRefSections
                  .map((sec) => {
                    let text = `// ${sec.label}\n${sec.code}`
                    if (sec.children) {
                      text += sec.children
                        .map((c) => `\n\n// ${c.label}\n${c.code}`)
                        .join('')
                    }
                    return text
                  })
                  .join('\n\n')
                copyRefCode('all', all)
              }}
              style={{
                ...btnStyle,
                fontSize: 11,
                padding: '2px 8px',
                background: copiedKey === 'all' ? '#a6e3a1' : '#45475a',
                color: copiedKey === 'all' ? '#1e1e2e' : '#cdd6f4',
                transition: 'background 0.2s, color 0.2s',
              }}
            >
              {copiedKey === 'all' ? 'Copied!' : 'Copy All'}
            </button>
          </div>
          {effectiveRefSections.map((sec, i) => {
            const key = `s${i}`
            const isOpen = expandedRef.has(key)
            const hasChildren = sec.children && sec.children.length > 0
            return (
              <div key={i}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleRefExpand(key)}
                    style={{
                      ...btnStyle,
                      fontSize: 11,
                      padding: '2px 6px',
                      minWidth: 18,
                      fontFamily: 'monospace',
                    }}
                  >
                    {isOpen ? '\u25BE' : '\u25B8'}
                  </button>
                  <span
                    style={{
                      fontWeight: 600,
                      color: '#89b4fa',
                      cursor: 'pointer',
                    }}
                    onClick={() => toggleRefExpand(key)}
                  >
                    {sec.label}
                  </span>
                  <span style={{ color: '#a6adc8', fontSize: 11 }}>
                    {sec.description}
                  </span>
                  {isOpen && (
                    <button
                      type="button"
                      onClick={() => copyRefCode(key, sec.code)}
                      style={{
                        ...btnStyle,
                        fontSize: 11,
                        padding: '2px 8px',
                        marginLeft: 'auto',
                        background: copiedKey === key ? '#a6e3a1' : '#45475a',
                        color: copiedKey === key ? '#1e1e2e' : '#cdd6f4',
                        transition: 'background 0.2s, color 0.2s',
                      }}
                    >
                      {copiedKey === key ? 'Copied!' : 'Copy'}
                    </button>
                  )}
                </div>
                {isOpen && (
                  <>
                    <pre
                      style={{
                        margin: '4px 0 0 24px',
                        padding: '8px 10px',
                        background: '#11111b',
                        borderRadius: 4,
                        color: '#cdd6f4',
                        fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.4,
                        border: '1px solid #313244',
                      }}
                    >
                      {sec.code}
                    </pre>
                    {hasChildren && (
                      <div
                        style={{
                          marginTop: 6,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          paddingLeft: 12,
                          borderLeft: '2px solid #313244',
                          marginLeft: 24,
                        }}
                      >
                        {sec.children!.map((child, ci) => {
                          const childKey = `s${i}c${ci}`
                          const childOpen = expandedRef.has(childKey)
                          return (
                            <div key={ci}>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleRefExpand(childKey)}
                                  style={{
                                    ...btnStyle,
                                    fontSize: 11,
                                    padding: '2px 6px',
                                    minWidth: 18,
                                    fontFamily: 'monospace',
                                  }}
                                >
                                  {childOpen ? '\u25BE' : '\u25B8'}
                                </button>
                                <span
                                  style={{
                                    fontWeight: 600,
                                    color: '#a6e3a1',
                                    cursor: 'pointer',
                                  }}
                                  onClick={() => toggleRefExpand(childKey)}
                                >
                                  {child.label}
                                </span>
                                <span
                                  style={{ color: '#a6adc8', fontSize: 11 }}
                                >
                                  {child.description}
                                </span>
                                {childOpen && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      copyRefCode(childKey, child.code)
                                    }
                                    style={{
                                      ...btnStyle,
                                      fontSize: 11,
                                      padding: '2px 8px',
                                      marginLeft: 'auto',
                                      background:
                                        copiedKey === childKey
                                          ? '#a6e3a1'
                                          : '#45475a',
                                      color:
                                        copiedKey === childKey
                                          ? '#1e1e2e'
                                          : '#cdd6f4',
                                      transition: 'background 0.2s, color 0.2s',
                                    }}
                                  >
                                    {copiedKey === childKey
                                      ? 'Copied!'
                                      : 'Copy'}
                                  </button>
                                )}
                              </div>
                              {childOpen && (
                                <pre
                                  style={{
                                    margin: '4px 0 0 24px',
                                    padding: '8px 10px',
                                    background: '#11111b',
                                    borderRadius: 4,
                                    color: '#cdd6f4',
                                    fontFamily: 'monospace',
                                    whiteSpace: 'pre-wrap',
                                    lineHeight: 1.4,
                                    border: '1px solid #313244',
                                  }}
                                >
                                  {child.code}
                                </pre>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div
        ref={editorContainerRef}
        style={{
          flex: testOutput ? '1 1 60%' : 1,
          overflow: 'hidden',
          fontSize,
          minHeight: 0,
        }}
      />

      {testOutput && (
        <div
          style={{
            flex: `0 0 ${consoleHeight}px`,
            background: '#0d0f13',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 80,
          }}
        >
          {/* Drag handle */}
          <div
            style={{
              height: 5,
              cursor: 'row-resize',
              background: '#2e333d',
              flexShrink: 0,
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              consoleDragRef.current = {
                startY: e.clientY,
                startH: consoleHeight,
              }
              const onMove = (ev: MouseEvent) => {
                if (!consoleDragRef.current) return
                const delta = consoleDragRef.current.startY - ev.clientY
                const next = Math.max(
                  80,
                  Math.min(
                    window.innerHeight - 120,
                    consoleDragRef.current.startH + delta,
                  ),
                )
                setConsoleHeight(next)
              }
              const onUp = () => {
                consoleDragRef.current = null
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
          />
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '4px 10px',
              background: '#14161b',
              borderBottom: '1px solid #2e333d',
              gap: 8,
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            <span style={{ color: '#a6adc8', fontWeight: 500 }}>Console</span>
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <button
                type="button"
                title="Copy console output"
                onClick={() => {
                  navigator.clipboard.writeText(testOutput.logs.join('\n'))
                  setConsoleCopied(true)
                  setTimeout(() => setConsoleCopied(false), 1500)
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: consoleCopied ? '#a6e3a1' : '#7f849c',
                  cursor: 'pointer',
                  fontSize: 13,
                  padding: '2px 6px',
                  transition: 'color 0.2s',
                }}
              >
                {consoleCopied ? <FiCheck /> : <FiCopy />}
              </button>
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation()
                  setTestOutput(null)
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#7f849c',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '4px 8px',
                  position: 'relative',
                  zIndex: 2,
                }}
              >
                Close
              </button>
            </div>
          </div>
          {/* Log output */}
          <div
            data-console-root=""
            onCopy={handleConsoleCopy}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '6px 10px',
              fontFamily: 'monospace',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {/* Placeholder when empty */}
            {testOutput.logs.length === 0 &&
              !testOutput.inputClips &&
              !testOutput.error && (
                <div
                  style={{
                    color: '#585b70',
                    fontStyle: 'italic',
                    padding: '8px 0',
                  }}
                >
                  Run a test to see output here
                </div>
              )}
            {/* Console log lines */}
            {testOutput.logs.map((line, i) => (
              <div
                key={`log-${i}`}
                style={{
                  color: line.startsWith('Error')
                    ? '#f38ba8'
                    : line.startsWith('[warn]')
                      ? '#f9e2af'
                      : line.startsWith('---')
                        ? '#7f849c'
                        : '#a6e3a1',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {line}
              </div>
            ))}

            {/* Structured data sections */}
            {testOutput.inputClips && testOutput.inputClips.length > 0 && (
              <>
                <div
                  style={{
                    color: '#7f849c',
                    marginTop: 8,
                    borderTop: '1px solid #2e333d',
                    paddingTop: 6,
                    fontSize: 11,
                  }}
                >
                  --- Test complete ---
                </div>
                <ConsoleEntry
                  label="Input Clips"
                  data={testOutput.inputClips}
                />
              </>
            )}
            {testOutput.outputClips && (
              <ConsoleEntry
                label={`Output Clips${testOutput.outputCount && testOutput.outputClips.length < testOutput.outputCount ? ` (showing ${testOutput.outputClips.length} of ${testOutput.outputCount})` : ''}`}
                data={testOutput.outputClips}
              />
            )}
            <div ref={consoleEndRef} />
          </div>
        </div>
      )}

      {templateNamePrompt !== null && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setTemplateNamePrompt(null)}
        >
          <div
            style={{
              background: '#313244',
              borderRadius: 6,
              padding: 16,
              minWidth: 280,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ marginBottom: 8, fontSize: 13 }}>Template name:</div>
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              style={{
                width: '100%',
                padding: '4px 8px',
                background: '#1e1e2e',
                color: '#cdd6f4',
                border: '1px solid #585b70',
                borderRadius: 4,
                fontSize: 13,
                boxSizing: 'border-box',
              }}
              value={templateNamePrompt}
              onChange={(e) => setTemplateNamePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSaveTemplate(templateNamePrompt)
                if (e.key === 'Escape') setTemplateNamePrompt(null)
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 6,
                marginTop: 10,
              }}
            >
              <button
                type="button"
                style={btnStyle}
                onClick={() => setTemplateNamePrompt(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ ...btnStyle, background: '#89b4fa', color: '#1e1e2e' }}
                onClick={() => commitSaveTemplate(templateNamePrompt)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 101,
          }}
          onClick={() => setPendingConfirm(null)}
        >
          <div
            style={{
              background: '#313244',
              borderRadius: 6,
              padding: 16,
              minWidth: 280,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              {pendingConfirm.message}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 6,
              }}
            >
              <button
                type="button"
                style={btnStyle}
                onClick={() => setPendingConfirm(null)}
              >
                No
              </button>
              <button
                type="button"
                style={{ ...btnStyle, background: '#89b4fa', color: '#1e1e2e' }}
                onClick={() => {
                  pendingConfirm.onYes()
                  setPendingConfirm(null)
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
