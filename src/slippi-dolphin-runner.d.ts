// slippi-dolphin-runner is ESM with an `exports` map, which this tsconfig's
// node (node10) module resolution doesn't read. Point TypeScript at the package's
// own declarations. Types only: webpack resolves the module itself (alias in
// .erb/configs/webpack.config.base.ts), Jest through moduleNameMapper.
declare module 'slippi-dolphin-runner' {
  export * from 'slippi-dolphin-runner/dist/index'
}
