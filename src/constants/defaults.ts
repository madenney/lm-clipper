import { SavedCustomFilter } from './types'

export const config = {
  recentProjects: [] as { name: string; path: string; lastOpened: number }[],
  lastArchivePath: null,
  projectName: '',
  hideHud: false,
  gameMusic: false,
  enableChants: false,
  disableScreenShake: false,
  hideTags: false,
  hideNames: false,
  overlaySource: false,
  fixedCamera: false,
  noElectricSFX: false,
  noCrowdNoise: false,
  disableMagnifyingGlass: false,
  shuffle: false,
  resolution: 2,
  playbackResolution: 2,
  bitrateKbps: 15000,
  addStartFrames: 0,
  addEndFrames: 0,
  lastClipOffset: 1,
  numCPUs: 1,
  numFilterThreads: 1,
  slice: 2,
  dolphinCutoff: 300,
  ssbmIsoPath: '',
  dolphinPath: '',
  outputPath: '',
  concatenate: false,
  convertToMp4: false,
  outputFilenamePattern: '{index}',
  defaultProjectDirectory: '',
  ffmpegPath: '',
  customGeckoCodes: [] as { name: string; code: string; enabled: boolean }[],
  detectDuplicatesOnImport: false,
  includeDefaultFilters: true,
  savedCustomFilters: [
    // ── Sampling ──
    {
      name: 'Random Sample',
      category: 'Sampling',
      description: 'Shuffle clips and take a random subset',
      code: `// Shuffle clips and take a random sample
const shuffled = [...clips]
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
}
return shuffled.slice(0, params.count)`,
      customParams: [{ name: 'count', type: 'int', value: '50' }],
      builtIn: true,
    },
    {
      name: 'Limit Per Player',
      category: 'Sampling',
      description: 'Cap the number of clips per player tag',
      code: `// Limit to N clips per player (by comboer display name)
const counts = {}
return clips.filter(clip => {
  const name = clip.comboer?.displayName || 'unknown'
  counts[name] = (counts[name] || 0) + 1
  return counts[name] <= params.maxPerPlayer
})`,
      customParams: [{ name: 'maxPerPlayer', type: 'int', value: '5' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Top N by Damage',
      category: 'Sampling',
      description: 'Keep only the highest-damage combos',
      code: `// Sort by total damage and keep top N
const withDmg = clips.map(clip => {
  const dmg = clip.combo?.moves?.reduce((s, m) => s + m.damage, 0) || 0
  return { clip, dmg }
})
withDmg.sort((a, b) => b.dmg - a.dmg)
return withDmg.slice(0, params.count).map(x => x.clip)`,
      customParams: [{ name: 'count', type: 'int', value: '100' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Top N by Hits',
      category: 'Sampling',
      description: 'Keep combos with the most hits',
      code: `// Sort by hit count and keep top N
const sorted = [...clips].sort((a, b) => {
  const hA = a.combo?.moves?.length || 0
  const hB = b.combo?.moves?.length || 0
  return hB - hA
})
return sorted.slice(0, params.count)`,
      customParams: [{ name: 'count', type: 'int', value: '100' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'One Per Game',
      category: 'Sampling',
      description: 'Keep only one clip per replay file',
      code: `// Keep the first clip from each unique game file
const seen = new Set()
return clips.filter(clip => {
  if (seen.has(clip.path)) return false
  seen.add(clip.path)
  return true
})`,
      builtIn: true,
    },
    {
      name: 'Limit Per Matchup',
      category: 'Sampling',
      description: 'Cap clips per character matchup pair',
      code: `// Limit clips per character matchup (sorted char pair)
const counts = {}
return clips.filter(clip => {
  if (!clip.comboer || !clip.comboee) return true
  const pair = [clip.comboer.characterId, clip.comboee.characterId].sort().join('-')
  counts[pair] = (counts[pair] || 0) + 1
  return counts[pair] <= params.maxPerMatchup
})`,
      customParams: [{ name: 'maxPerMatchup', type: 'int', value: '10' }],
      builtIn: true,
      requiresParser: true,
    },

    // ── Combos ──
    {
      name: 'Damage Range',
      category: 'Combos',
      description: 'Filter combos by total damage dealt',
      code: `// Filter combos by total damage dealt
return clips.filter(clip => {
  if (!clip.combo?.moves) return false
  const totalDmg = clip.combo.moves.reduce((sum, m) => sum + m.damage, 0)
  return totalDmg >= params.minDamage && (params.maxDamage === 0 || totalDmg <= params.maxDamage)
})`,
      customParams: [
        { name: 'minDamage', type: 'int', value: '60' },
        { name: 'maxDamage', type: 'int', value: '0' },
      ],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Contains Move',
      category: 'Combos',
      description: 'Keep combos containing specific move IDs',
      code: `// Keep combos that contain specific moves
// Move IDs: 2-4=jab 5=rapid-jab 6=dash-attack 7=ftilt 8=utilt 9=dtilt
// 10=fsmash 11=usmash 12=dsmash 13=nair 14=fair 15=bair 16=uair 17=dair
// 18=neutral-b 19=side-b 20=up-b 21=down-b 50=grab 52=pummel 53-56=throws
const moveIds = params.moveIds.map(Number)
return clips.filter(clip => {
  if (!clip.combo?.moves) return false
  return moveIds.some(id => clip.combo.moves.some(m => m.moveId === id))
})`,
      customParams: [{ name: 'moveIds', type: 'array', value: '17' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Exclude Move',
      category: 'Combos',
      description: 'Remove combos containing specific move IDs',
      code: `// Remove combos that contain any of these moves
const moveIds = new Set(params.moveIds.map(Number))
return clips.filter(clip => {
  if (!clip.combo?.moves) return true
  return !clip.combo.moves.some(m => moveIds.has(m.moveId))
})`,
      customParams: [{ name: 'moveIds', type: 'array', value: '52' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Starts With Move',
      category: 'Combos',
      description: 'Keep combos that start with a specific move',
      code: `// Keep combos where the first move matches
const moveIds = new Set(params.moveIds.map(Number))
return clips.filter(clip => {
  const first = clip.combo?.moves?.[0]
  return first && moveIds.has(first.moveId)
})`,
      customParams: [{ name: 'moveIds', type: 'array', value: '50' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Ends With Move',
      category: 'Combos',
      description: 'Keep combos that end with a specific move',
      code: `// Keep combos where the last move matches
const moveIds = new Set(params.moveIds.map(Number))
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves || moves.length === 0) return false
  return moveIds.has(moves[moves.length - 1].moveId)
})`,
      customParams: [{ name: 'moveIds', type: 'array', value: '14' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Move Sequence',
      category: 'Combos',
      description: 'Keep combos containing moves in a specific order',
      code: `// Keep combos that contain this move sequence (in order, not necessarily consecutive)
const seq = params.sequence.map(Number)
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves) return false
  let si = 0
  for (const m of moves) {
    if (m.moveId === seq[si]) {
      si++
      if (si >= seq.length) return true
    }
  }
  return false
})`,
      customParams: [{ name: 'sequence', type: 'array', value: '50,17' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'No Pummels',
      category: 'Combos',
      description: 'Remove combos that include pummels',
      code: `// Filter out combos containing pummels (moveId 52)
return clips.filter(clip => {
  if (!clip.combo?.moves) return true
  return !clip.combo.moves.some(m => m.moveId === 52)
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'No Grabs',
      category: 'Combos',
      description: 'Remove combos that include grabs',
      code: `// Filter out combos containing grabs (moveId 50) or pummels (52) or throws (53-56)
const grabMoves = new Set([50, 52, 53, 54, 55, 56])
return clips.filter(clip => {
  if (!clip.combo?.moves) return true
  return !clip.combo.moves.some(m => grabMoves.has(m.moveId))
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Unique Moves Only',
      category: 'Combos',
      description: 'Keep combos where every move is different',
      code: `// Keep combos with all unique moves (no repeated move IDs)
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves) return false
  const ids = moves.map(m => m.moveId)
  return new Set(ids).size === ids.length
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Min Unique Moves',
      category: 'Combos',
      description: 'Require a minimum number of distinct moves',
      code: `// Keep combos with at least N distinct move IDs
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves) return false
  const unique = new Set(moves.map(m => m.moveId))
  return unique.size >= params.minUnique
})`,
      customParams: [{ name: 'minUnique', type: 'int', value: '4' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'High DPS',
      category: 'Combos',
      description: 'Keep combos above a damage-per-second threshold',
      code: `// Filter by damage per second (60fps)
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves || moves.length === 0) return false
  const dmg = moves.reduce((s, m) => s + m.damage, 0)
  const frames = (clip.endFrame || 0) - (clip.startFrame || 0)
  if (frames <= 0) return false
  const dps = dmg / (frames / 60)
  return dps >= params.minDPS
})`,
      customParams: [{ name: 'minDPS', type: 'int', value: '30' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Short Combos',
      category: 'Combos',
      description: 'Keep only combos under a frame duration',
      code: `// Keep combos shorter than maxFrames
return clips.filter(clip => {
  const dur = (clip.endFrame || 0) - (clip.startFrame || 0)
  return dur > 0 && dur <= params.maxFrames
})`,
      customParams: [{ name: 'maxFrames', type: 'int', value: '120' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Long Combos',
      category: 'Combos',
      description: 'Keep only combos over a frame duration',
      code: `// Keep combos longer than minFrames
return clips.filter(clip => {
  const dur = (clip.endFrame || 0) - (clip.startFrame || 0)
  return dur >= params.minFrames
})`,
      customParams: [{ name: 'minFrames', type: 'int', value: '180' }],
      builtIn: true,
      requiresParser: true,
    },

    // ── Kills ──
    {
      name: 'Early Kills',
      category: 'Kills',
      description: 'Kills where opponent was below a percent threshold',
      code: `// Keep combos that kill at low percent
return clips.filter(clip => {
  if (!clip.combo?.didKill) return false
  const startPct = clip.combo.startPercent || 0
  return startPct <= params.maxStartPercent
})`,
      customParams: [{ name: 'maxStartPercent', type: 'int', value: '40' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Late Kills',
      category: 'Kills',
      description: 'Kills where opponent was above a percent threshold',
      code: `// Keep combos that kill at high percent
return clips.filter(clip => {
  if (!clip.combo?.didKill) return false
  const startPct = clip.combo.startPercent || 0
  return startPct >= params.minStartPercent
})`,
      customParams: [{ name: 'minStartPercent', type: 'int', value: '120' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Single-Hit Kills',
      category: 'Kills',
      description: 'Kills from a single move (raw KOs)',
      code: `// Keep single-hit kills
return clips.filter(clip => {
  if (!clip.combo?.didKill) return false
  return clip.combo.moves?.length === 1
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Kill Confirms',
      category: 'Kills',
      description: 'Short combos (2-3 hits) that result in a kill',
      code: `// Keep short kill combos (kill confirms)
return clips.filter(clip => {
  if (!clip.combo?.didKill) return false
  const hits = clip.combo.moves?.length || 0
  return hits >= 2 && hits <= params.maxHits
})`,
      customParams: [{ name: 'maxHits', type: 'int', value: '3' }],
      builtIn: true,
      requiresParser: true,
    },

    // ── Utility ──
    {
      name: 'Percent Range',
      category: 'Utility',
      description: 'Filter by opponent start percent',
      code: `// Keep clips where the comboee starts in a percent range
return clips.filter(clip => {
  const pct = clip.combo?.startPercent ?? -1
  if (pct < 0) return false
  return pct >= params.minPercent && (params.maxPercent === 0 || pct <= params.maxPercent)
})`,
      customParams: [
        { name: 'minPercent', type: 'int', value: '0' },
        { name: 'maxPercent', type: 'int', value: '50' },
      ],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Clip Duration Range',
      category: 'Utility',
      description: 'Filter clips by frame count duration',
      code: `// Keep clips within a duration range (in frames, 60fps)
return clips.filter(clip => {
  const dur = (clip.endFrame || 0) - (clip.startFrame || 0)
  if (dur <= 0) return false
  const inRange = dur >= params.minFrames
  return params.maxFrames === 0 ? inRange : inRange && dur <= params.maxFrames
})`,
      customParams: [
        { name: 'minFrames', type: 'int', value: '60' },
        { name: 'maxFrames', type: 'int', value: '0' },
      ],
      builtIn: true,
    },
    {
      name: 'Remove Dittos',
      category: 'Utility',
      description: 'Exclude mirror-matchup clips',
      code: `// Remove ditto (mirror) matchups
return clips.filter(clip => {
  if (!clip.comboer || !clip.comboee) return true
  return clip.comboer.characterId !== clip.comboee.characterId
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Dittos Only',
      category: 'Utility',
      description: 'Keep only mirror-matchup clips',
      code: `// Keep only ditto (mirror) matchups
return clips.filter(clip => {
  if (!clip.comboer || !clip.comboee) return false
  return clip.comboer.characterId === clip.comboee.characterId
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Date Range',
      category: 'Utility',
      description: 'Filter clips by game date',
      code: `// Filter by date range (YYYY-MM-DD format)
const minDate = params.startDate ? new Date(params.startDate).getTime() / 1000 : 0
const maxDate = params.endDate ? new Date(params.endDate).getTime() / 1000 : Infinity
return clips.filter(clip => {
  const t = clip.startedAt || 0
  return t >= minDate && t <= maxDate
})`,
      customParams: [
        { name: 'startDate', type: 'string', value: '2023-01-01' },
        { name: 'endDate', type: 'string', value: '' },
      ],
      builtIn: true,
    },
    {
      name: 'Exclude Players',
      category: 'Utility',
      description: 'Remove clips featuring specific player tags',
      code: `// Exclude clips where any player matches the list
const names = new Set(params.playerNames.map(n => n.trim().toLowerCase()))
return clips.filter(clip => {
  const players = clip.players || [clip.comboer, clip.comboee].filter(Boolean)
  return !players.some(p =>
    names.has((p.displayName || '').toLowerCase()) ||
    names.has((p.connectCode || '').toLowerCase())
  )
})`,
      customParams: [{ name: 'playerNames', type: 'array', value: '' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Merge Overlapping Clips',
      category: 'Utility',
      description: 'Merge clips from the same game that overlap in time',
      code: `// Merge clips from the same file that overlap or are within N frames
const gap = params.mergeGap || 0
const byFile = {}
for (const clip of clips) {
  if (!byFile[clip.path]) byFile[clip.path] = []
  byFile[clip.path].push(clip)
}
const result = []
for (const path of Object.keys(byFile)) {
  const group = byFile[path].sort((a, b) => a.startFrame - b.startFrame)
  let merged = { ...group[0] }
  for (let i = 1; i < group.length; i++) {
    if (group[i].startFrame <= merged.endFrame + gap) {
      merged.endFrame = Math.max(merged.endFrame, group[i].endFrame)
    } else {
      result.push(merged)
      merged = { ...group[i] }
    }
  }
  result.push(merged)
}
return result`,
      customParams: [{ name: 'mergeGap', type: 'int', value: '30' }],
      builtIn: true,
    },

    // ── Advanced ──
    {
      name: 'Frame Data Analysis',
      category: 'Advanced',
      description:
        'Analyze frame data with SlippiGame (slow — reads .slp files)',
      code: `// Use SlippiGame to analyze frame data
// This example filters for combos where the comboer wavedashes
return clips.filter(clip => {
  try {
    const game = new SlippiGame(clip.path)
    const stats = game.getStats()
    if (!stats?.actionCounts) return false
    const pIdx = clip.comboer?.playerIndex ?? 0
    const counts = stats.actionCounts[pIdx]
    if (!counts) return false
    return counts.wavedashCount >= params.minWavedashes
  } catch (e) { return false }
})`,
      customParams: [{ name: 'minWavedashes', type: 'int', value: '3' }],
      outputFields: [{ name: 'wavedashCount', type: 'number' }],
      builtIn: true,
    },
    {
      name: 'Custom Property',
      category: 'Advanced',
      description:
        'Add a computed property to each clip for downstream filters',
      code: `// Add a custom property to each clip
// Downstream filters and sort can reference this field
return clips.map(clip => {
  const moves = clip.combo?.moves || []
  const totalDmg = moves.reduce((s, m) => s + m.damage, 0)
  const frames = (clip.endFrame || 0) - (clip.startFrame || 0)
  clip.dps = frames > 0 ? totalDmg / (frames / 60) : 0
  return clip
})`,
      outputFields: [{ name: 'dps', type: 'number' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Group & Rank',
      category: 'Advanced',
      description: 'Rank clips within groups and keep top N per group',
      code: `// Group clips by comboer and keep top N per player sorted by damage
const groups = {}
for (const clip of clips) {
  const key = clip.comboer?.displayName || 'unknown'
  if (!groups[key]) groups[key] = []
  groups[key].push(clip)
}
const result = []
for (const key of Object.keys(groups)) {
  groups[key].sort((a, b) => {
    const dA = a.combo?.moves?.reduce((s, m) => s + m.damage, 0) || 0
    const dB = b.combo?.moves?.reduce((s, m) => s + m.damage, 0) || 0
    return dB - dA
  })
  result.push(...groups[key].slice(0, params.topN))
}
return result`,
      customParams: [{ name: 'topN', type: 'int', value: '5' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Consecutive Aerials',
      category: 'Advanced',
      description: 'Keep combos with N+ aerial moves in a row',
      code: `// Keep combos with N or more consecutive aerial moves
// Aerials: 13=nair, 14=fair, 15=bair, 16=uair, 17=dair
const aerials = new Set([13, 14, 15, 16, 17])
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves) return false
  let streak = 0
  for (const m of moves) {
    streak = aerials.has(m.moveId) ? streak + 1 : 0
    if (streak >= params.minConsecutive) return true
  }
  return false
})`,
      customParams: [{ name: 'minConsecutive', type: 'int', value: '3' }],
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'All Aerials',
      category: 'Advanced',
      description: 'Keep combos where every hit is an aerial',
      code: `// Keep combos where all moves are aerials
const aerials = new Set([13, 14, 15, 16, 17])
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves || moves.length === 0) return false
  return moves.every(m => aerials.has(m.moveId))
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Spike Finisher',
      category: 'Advanced',
      description: 'Keep combos that end with a spike/meteor (dair)',
      code: `// Keep combos ending with dair (moveId 17)
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves || moves.length === 0) return false
  return moves[moves.length - 1].moveId === 17
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Smash Finisher',
      category: 'Advanced',
      description: 'Keep combos that end with a smash attack',
      code: `// Keep combos ending with a smash attack (10=fsmash, 11=usmash, 12=dsmash)
const smashes = new Set([10, 11, 12])
return clips.filter(clip => {
  const moves = clip.combo?.moves
  if (!moves || moves.length === 0) return false
  return smashes.has(moves[moves.length - 1].moveId)
})`,
      builtIn: true,
      requiresParser: true,
    },
    {
      name: 'Reverse 3-Stock',
      category: 'Advanced',
      description:
        'Template for finding reverse 3-stocks via frame data (slow)',
      code: `// Find reverse 3-stocks — games where a player came back from 3 stocks down
// WARNING: This reads every .slp file — very slow on large datasets!
// Use a sampling filter first to limit the input set.
const seen = new Set()
return clips.filter(clip => {
  if (seen.has(clip.path)) return false
  try {
    const game = new SlippiGame(clip.path)
    const metadata = game.getMetadata()
    if (!metadata?.lastFrame) return false
    // Check if game went to last stock (both players had 1 stock)
    seen.add(clip.path)
    return true // Customize this logic for your needs
  } catch (e) { return false }
})`,
      builtIn: true,
    },
    {
      name: 'Stage Position Filter',
      category: 'Advanced',
      description: 'Filter by player position during the combo',
      code: `// Keep combos where the comboer was in a specific stage region
// This reads .slp frame data — slow!
return clips.filter(clip => {
  try {
    const game = new SlippiGame(clip.path)
    const frames = game.getFrames()
    const pIdx = clip.comboer?.playerIndex ?? 0
    const start = clip.startFrame || 0
    const end = clip.endFrame || start
    for (let f = start; f <= end; f++) {
      const pf = frames[f]?.players?.[pIdx]?.post
      if (!pf) continue
      const x = pf.positionX ?? 0
      const y = pf.positionY ?? 0
      if (x >= params.minX && x <= params.maxX && y >= params.minY && y <= params.maxY) {
        return true
      }
    }
    return false
  } catch (e) { return false }
})`,
      customParams: [
        { name: 'minX', type: 'int', value: '-200' },
        { name: 'maxX', type: 'int', value: '200' },
        { name: 'minY', type: 'int', value: '0' },
        { name: 'maxY', type: 'int', value: '200' },
      ],
      builtIn: true,
    },
  ] as SavedCustomFilter[],
  testMode: false,
}

export const archive = {
  path: '',
  name: 'default_lm_project',
  createdAt: 1006329600,
  files: 0,
  filters: [
    {
      id: 'filter_0',
      label: 'Game Filter',
      type: 'files',
      isProcessed: false,
      results: 0,
      params: {
        stage: '',
        char1: '',
        char2: '',
        player1: '',
        player2: '',
      },
    },
    {
      id: 'filter_1',
      label: 'Combo Parser',
      type: 'slpParser',
      isProcessed: false,
      results: 0,
      params: {
        minHits: '2',
        maxHits: '',
        maxFiles: '',
        comboTimeout: '',
        comboerChar: [],
        comboeeChar: [],
        comboerTag: [],
        comboerCC: [],
        comboeeTag: [],
        comboeeCC: [],
        didKill: false,
      },
    },
    {
      id: 'filter_2',
      label: 'Combo Filter',
      type: 'comboFilter',
      isProcessed: false,
      results: 0,
      params: {
        minHits: '3',
        maxHits: '',
        minDamage: '',
        comboerChar: [],
        comboerTag: [],
        comboerCC: [],
        comboeeChar: [],
        comboeeTag: [],
        comboeeCC: [],
        comboStage: [],
        didKill: true,
        countPummels: false,
        nthMoves: [],
      },
    },
  ],
}
