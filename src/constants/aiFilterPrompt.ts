/**
 * The AI Filter's prompt (user, 2026-10-03): the user describes what they
 * want, copies this into their own ChatGPT / Claude, and pastes the code back.
 * Clipper never calls an AI itself. The code runs exactly like Custom Code
 * (models/methods/custom.ts): a function body given `clips`, `params`,
 * `SlippiGame` and `console`, returning an array of clips.
 */

/** What the step before the AI Filter hands it. */
export type AiFilterInput = 'games' | 'combos' | 'edgeguards' | 'clips'

/** The step type before the AI Filter -> what its rows are. */
export function aiFilterInput(previousType: string | undefined): AiFilterInput {
  if (!previousType || previousType === 'files') return 'games'
  if (
    ['slpParser', 'comboFilter', 'zeroToDeaths', 'reverse'].includes(
      previousType,
    )
  )
    return 'combos'
  if (['edgeguard', 'edgeguardFilter'].includes(previousType))
    return 'edgeguards'
  return 'clips'
}

const INPUT_TEXT: Record<AiFilterInput, string> = {
  games: `Each item in \`clips\` is a WHOLE GAME (one replay file), not a moment yet:
\`\`\`
{
  path: string        // absolute path to the .slp file
  stage: number       // stage id (2 Fountain, 3 Stadium, 8 Yoshi's, 28 Dream Land, 31 Battlefield, 32 Final Destination)
  startedAt?: number  // Unix time the game started
  lastFrame?: number  // last frame of the game
  players: { playerIndex, port, characterId, characterColor, displayName, connectCode, nametag, cpu? }[]
  // cpu: true = a CPU (computer) player; missing or null = not known (treat as human)
}
\`\`\`
To find moments inside games, open each file with \`new SlippiGame(clip.path)\` and
return NEW clip objects for the moments (see "What to return"). Returning a game
item unchanged keeps the whole game.`,
  combos: `Each item in \`clips\` is a COMBO found by the combo parser:
\`\`\`
{
  path: string, stage: number, startedAt?: number,
  startFrame: number, endFrame: number,
  comboer: { playerIndex, port, characterId, characterColor, displayName, connectCode, nametag },  // who did the combo
  comboee: { ...same shape },                                                                  // who got comboed
  combo: {
    startPercent: number, endPercent: number | null, didKill: boolean,
    moves: { playerIndex, frame, moveId, hitCount, damage }[]   // moveId (Slippi ids): 2-4 jab, 6 dash attack, 7 ftilt, 8 utilt, 9 dtilt, 10 fsmash, 11 usmash, 12 dsmash, 13 nair, 14 fair, 15 bair, 16 uair, 17 dair, 18 neutral b, 19 side b, 20 up b, 21 down b, 53-56 fthrow/bthrow/uthrow/dthrow
  }
}
\`\`\``,
  edgeguards: `Each item in \`clips\` is an EDGEGUARD (a recovery the attacker tried to stop):
\`\`\`
{
  path: string, stage: number, startedAt?: number,
  startFrame: number, endFrame: number,
  comboer: { playerIndex, port, characterId, displayName, connectCode, ... },  // the edgeguarder
  comboee: { ...same shape },                                                  // the recovering player
  edgeguardMetrics?: { ... }   // scores and measurements from the edgeguard detector
}
\`\`\``,
  clips: `Each item in \`clips\` is a clip (a moment in a game) from the previous step:
\`\`\`
{ path: string, stage: number, startFrame: number, endFrame: number,
  comboer?: { playerIndex, port, characterId, displayName, connectCode, ... },
  comboee?: { ...same shape }, ...other fields added by earlier steps }
\`\`\``,
}

/**
 * The prompt the user pastes into their AI first. It explains the task; they
 * then describe the clips they want in the chat (AiFilterGuide, step 1).
 */
export function buildAiFilterPrompt(input: AiFilterInput): string {
  return `I'm using Lunar Clipper, a desktop app that makes video clips from Super Smash Bros. Melee replays (.slp files from Slippi). I need you to write the code for one "AI Filter" step, which picks the moments to clip. I describe the clips I want at the very end of this message.

## How the code runs

Write the BODY of a JavaScript function (not the function itself). It gets:
- \`clips\`: some of the items from the previous step (below)
- \`total\`: how many items the previous step has in all
- \`SlippiGame\`: the @slippi/slippi-js class — \`new SlippiGame(path)\`, then \`.getSettings()\`, \`.getMetadata()\`, \`.getStats()\` (stocks, conversions, combos, actionCounts, overall), \`.getFrames()\` ({ [frame]: { players: { [index]: { pre, post } } } }; post has actionStateId, positionX/Y, percent, stocksRemaining, isAirborne, facingDirection …; pre has inputs)
- \`params\`: this step's settings (ignore it)
- \`console\`: log / warn / error for debugging

There is no require/import, no network, no filesystem and no DOM. Opening a
replay is slow, so only open files you need. Plain modern JavaScript only.

The function is called many times, on a few items at a time (one game per call
when the input is whole games), not once on everything. So decide about each
item on its own: no "top 10" or ranking across items (a later Sort step does
that), and no state carried between calls. \`total\` holds the size of the whole
input if you need it (e.g. for random sampling).

## The input

${INPUT_TEXT[input]}

## What to return

Return an array of clips. A clip is a moment to show:
\`\`\`
{ path, stage, startFrame, endFrame,       // frames as in the replay (the game starts at -123)
  comboer?, comboee?,                       // the two players (playerIndex, port, characterId, …), used for overlays
  ...anything else you want to keep }
\`\`\`
You can filter the input, change startFrame/endFrame, or build new clips. Leave a
little lead-in (about 60 frames before the action starts).

## How to answer

Reply with ONE \`\`\`js code block containing the whole function body, ending in
a \`return\`, so I can paste it straight into the app. Keep any explanation short
and outside the block. If I later ask for changes, reply with the whole updated
block again.

## The clips I want

(Write what you want below, in your own words. For example: "every time Fox
shines out of shield and gets a kill".)

`
}

/** The code in an AI's reply: the first fenced block, else the whole reply. */
export function extractCode(reply: string): string {
  const fence = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(reply)
  return (fence ? fence[1] : reply).trim()
}
