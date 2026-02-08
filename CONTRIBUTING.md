# Contributing to LM Clipper

Thanks for your interest in contributing! This document covers development setup, code style, and how to submit changes.

## Development Setup

### Prerequisites

- Node.js >= 18
- npm
- Git

### Getting Started

```bash
git clone https://github.com/madenney/lm-clipper.git
cd lm-clipper
npm install
npm run start
```

This starts the webpack dev server and Electron in development mode with hot reloading for the renderer process.

### Useful Commands

```bash
npm run start              # Start dev environment (webpack + electron)
npm run start:main         # Build and run main process only
npm run start:renderer     # Start webpack dev server for React only
npm run build              # Build main + renderer for production
npm run lint               # ESLint on .js/.jsx/.ts/.tsx
npm test                   # Run Jest tests
```

### Project Structure

```
src/
  main/           # Electron main process (IPC, DB, video generation)
  renderer/       # React UI (components, hooks)
  models/         # Filter engine, worker threads
  constants/      # Types, character/stage data
  lib/            # Shared utilities
release/app/      # Packaged app dependencies
.erb/             # Webpack configs and build scripts
```

### Notes

- The main process (`src/main/`) is watched by electronmon -- changes auto-restart Electron.
- Worker files (`src/models/Worker.ts`) are **not** watched by electronmon. Changes to workers require a full restart of `npm start`.
- Native dependencies like `better-sqlite3` must be installed in `release/app/node_modules/`.

## Code Style

- TypeScript with strict mode
- Prettier: single quotes, no semicolons
- ESLint: erb config base

Run `npm run lint` before submitting a PR.

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Run `npm run lint` and `npm test`
5. Commit with a clear message describing the change
6. Push to your fork and open a Pull Request

### PR Guidelines

- Keep PRs focused on a single change
- Include a description of what changed and why
- If the PR adds a new feature, explain the use case
- Make sure CI passes before requesting review
