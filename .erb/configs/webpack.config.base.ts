/**
 * Base webpack config used across other specific configs
 */

import path from 'path'
import webpack from 'webpack'
import TsconfigPathsPlugins from 'tsconfig-paths-webpack-plugin'
import webpackPaths from './webpack.paths'
import { dependencies as externals } from '../../release/app/package.json'
import { ownerToolsPlugins } from './ownerTools'

const externalsKeys = Object.keys(externals || {})
const isDev = process.env.NODE_ENV === 'development'

const configuration: webpack.Configuration = {
  externals: [
    function ({ request }, callback) {
      if (request && externalsKeys.includes(request)) {
        if (isDev && request !== 'electron') {
          // In dev the bundle runs from .erb/dll/ which can't resolve
          // native modules in release/app/node_modules via normal lookup.
          // Use an absolute path so Node finds the electron-rebuilt copy.
          // Skip 'electron' — it's provided by the Electron runtime itself.
          const absPath = path.join(webpackPaths.appNodeModulesPath, request)
          return callback(null, `commonjs2 ${absPath}`)
        }
        return callback(null, `commonjs2 ${request}`)
      }
      return callback()
    },
  ],

  stats: 'errors-only',

  module: {
    // slippi-viewer ships one self-contained IIFE bundle (no imports to follow);
    // parsing it only produces "Critical dependency: require" warnings from its
    // esbuild require shim.
    noParse: /[\\/]@gcpreston[\\/]slippi-viewer[\\/]dist[\\/]index\.js$/,
    rules: [
      // slippi-dolphin-runner finds its bundled lunar-hidden-launcher.exe with
      // new URL(`../native/win/bin/${name}`, import.meta.url), which webpack
      // would otherwise copy into dist/ (inside app.asar, where an exe can't
      // run) together with SHA256SUMS. Clipper ships the launcher unpacked
      // (build.win.extraResources) and passes its path (src/main/hideLauncher.ts).
      {
        test: /[\\/]slippi-dolphin-runner[\\/]dist[\\/].*\.js$/,
        parser: { url: false },
      },
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            // Remove this line to enable type checking in webpack builds
            transpileOnly: true,
            compilerOptions: {
              module: 'esnext',
            },
          },
        },
      },
    ],
  },

  output: {
    path: webpackPaths.srcPath,
    // https://github.com/webpack/webpack/issues/1114
    library: {
      type: 'commonjs2',
    },
  },

  /**
   * Determine the array of extensions that should be used to resolve modules.
   */
  resolve: {
    extensions: ['.js', '.jsx', '.json', '.ts', '.tsx'],
    modules: [webpackPaths.srcPath, 'node_modules'],
    // slippi-dolphin-runner only exports an `import` condition; our TypeScript
    // compiles to require(), so point at its ESM entry directly (webpack bundles it).
    alias: {
      // src/node_modules is a link to release/app/node_modules (link-modules.ts)
      // and is searched first, so a package both have resolves to the app's
      // copy: release/app has yauzl 2 (via electron's extract-zip), which has
      // no openPromise, and ZIP imports failed in every packaged build. Ours.
      yauzl$: path.join(webpackPaths.rootPath, 'node_modules', 'yauzl'),
      'slippi-dolphin-runner$': path.join(
        webpackPaths.rootPath,
        'node_modules',
        'slippi-dolphin-runner',
        'dist',
        'index.js',
      ),
    },
    // There is no need to add aliases here, the paths in tsconfig get mirrored
    plugins: [new TsconfigPathsPlugins()],
  },

  plugins: [
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
    }),
    ...ownerToolsPlugins(),
  ],
}

export default configuration
