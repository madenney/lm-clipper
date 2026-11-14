// Jest setup: say so when the renderer and main bundles are not built. A warning, not an error:
// the unit tests import source, not the bundles, so a fresh checkout can run `npm test` at once
// (it used to throw unless CI was set).
import path from 'path';
import chalk from 'chalk';
import fs from 'fs';
import webpackPaths from '../configs/webpack.paths';

if (!process.env.CI) {
  const mainPath = path.join(webpackPaths.distMainPath, 'main.js');
  const rendererPath = path.join(webpackPaths.distRendererPath, 'renderer.js');

  if (!fs.existsSync(mainPath)) {
    console.warn(
      chalk.yellow(
        'Note: the main process is not built (npm run build:main); unit tests do not need it.'
      )
    );
  }

  if (!fs.existsSync(rendererPath)) {
    console.warn(
      chalk.yellow(
        'Note: the renderer is not built (npm run build:renderer); unit tests do not need it.'
      )
    );
  }
}
