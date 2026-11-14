// Jest transform for slippi-dolphin-runner's ESM dist: ts-jest turns it into
// CommonJS, where `import.meta` is a syntax error (0.5.8 finds its bundled
// hide launcher with `new URL(..., import.meta.url)`). Swap in the CommonJS
// equivalent, then hand the file to ts-jest as before.
const { createTransformer } = require('ts-jest').default;

const tsJest = createTransformer();
const IMPORT_META_URL = /\bimport\.meta\.url\b/g;
const CJS_URL = "require('url').pathToFileURL(__filename).href";

module.exports = {
  process(src, file, opts) {
    return tsJest.process(src.replace(IMPORT_META_URL, CJS_URL), file, opts);
  },
  getCacheKey(src, file, opts) {
    return `${tsJest.getCacheKey(src, file, opts)}:import-meta-1`;
  },
};
