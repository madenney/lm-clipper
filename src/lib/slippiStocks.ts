import { SlippiGame, Stats, StockComputer, StockType } from '@slippi/slippi-js'

// SlippiGame.getStats() registers six stat computers (actions, combos,
// conversions, inputs, stocks, target-breaks) and then runs generateOverallStats
// over every frame. Edgeguard detection only needs stock (death) data, so we run
// just the StockComputer. Output is byte-for-byte the same stock list, at ~1/3
// less post-parse CPU per file — meaningful across millions of replays.
export function computeStocks(game: SlippiGame): StockType[] {
  const settings = game.getSettings()
  if (!settings) return []
  const frames = game.getFrames()
  const stockComputer = new StockComputer()
  const stats = new Stats()
  stats.register(stockComputer)
  stats.setup(settings)
  // Feed frames in chronological order (negative pre-GO indices first).
  const orderedKeys = Object.keys(frames)
    .map(Number)
    .sort((a, b) => a - b)
  for (const k of orderedKeys) {
    const frame = frames[k]
    if (frame) stats.addFrame(frame)
  }
  stats.process()
  return stockComputer.fetch()
}
