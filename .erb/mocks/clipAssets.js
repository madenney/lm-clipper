// Jest mock for clipAssets (uses webpack require.context)
module.exports = {
  arrowImages: {},
  getArrowImage: () => '',
  resolveStageImage: () => '',
  getStageTag: () => '',
  getStageName: () => '',
  resolveCharacterImage: () => '',
  getCharacterName: () => null,
  getCharacterShortName: () => null,
  // Like the real one minus the character fallback (no character table here).
  getPlayerLabel: (p) => (p ? p.displayName || p.nametag || '' : ''),
}
