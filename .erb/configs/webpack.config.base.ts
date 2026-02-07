/**
 * Base webpack config used across other specific configs
 */

import path from 'path';
import webpack from 'webpack';
import TsconfigPathsPlugins from 'tsconfig-paths-webpack-plugin';
import webpackPaths from './webpack.paths';
import { dependencies as externals } from '../../release/app/package.json';

const externalsKeys = Object.keys(externals || {});
const isDev = process.env.NODE_ENV === 'development';

const configuration: webpack.Configuration = {
  externals: [
    function ({ request }, callback) {
      if (request && externalsKeys.includes(request)) {
        if (isDev && request !== 'electron') {
          // In dev the bundle runs from .erb/dll/ which can't resolve
          // native modules in release/app/node_modules via normal lookup.
          // Use an absolute path so Node finds the electron-rebuilt copy.
          // Skip 'electron' — it's provided by the Electron runtime itself.
          const absPath = path.join(webpackPaths.appNodeModulesPath, request);
          return callback(null, `commonjs2 ${absPath}`);
        }
        return callback(null, `commonjs2 ${request}`);
      }
      return callback();
    },
  ],

  stats: 'errors-only',

  module: {
    rules: [
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
    // There is no need to add aliases here, the paths in tsconfig get mirrored
    plugins: [new TsconfigPathsPlugins()],
  },

  plugins: [
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
    }),
  ],
};

export default configuration;
