// Slippi frame sentinels.
//
// A Melee game's frames start at -123 (the "Ready/Go" pre-game countdown), so
// -123 also doubles as "play/record from the very start of the game". FRAME_MAX
// is an effectively-unbounded end frame used when a real end isn't known.
export const GAME_START_FRAME = -123
export const FRAME_MAX = 99999
