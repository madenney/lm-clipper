#!/bin/sh
# Compile the filter, missing-replay, CPU-player and game-length workers, the import path (.slpz), the tray overview reader, window reads (read lane) and selections and run their checks under Electron's Node (the ABI
# better-sqlite3 is built for). Usage, from apps/clipper: scripts/worker-check/run.sh
set -e
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
# Loose compile: only emitting JS matters here (npm run typecheck checks types).
npx tsc src/models/Worker.ts src/models/File.ts src/main/MissingCheckWorker.ts src/main/CpuScanWorker.ts src/main/LastFrameScanWorker.ts src/lib/lastFrame.ts src/main/overview.ts src/main/overviewCache.ts src/main/rowSeek.ts src/main/readLane.ts src/main/DbReadWorker.ts src/main/selectionSql.ts src/lib/selection.ts src/main/removeRows.ts src/main/replayLibrary.ts \
  src/models/Archive.ts src/models/ImportWorker.ts src/main/dbAsync.ts src/main/DbWorker.ts src/main/replayExtraction.ts src/main/zipImportFolder.ts --outDir "$OUT/out" --rootDir src --module commonjs \
  --target es2020 --esModuleInterop --skipLibCheck --baseUrl src --resolveJsonModule \
  --allowJs >/dev/null 2>&1 || true
# Webpack resolves new URL('./X.ts', import.meta.url) for workers; plain Node
# needs the compiled .js beside the module instead.
find "$OUT/out" -name '*.js' -exec sed -i -E "s#new URL\('(\./[A-Za-z]+)\.ts', import\.meta\.url\)#require('path').join(__dirname, '\1.js')#g" {} +
for check in harness.js usercode.js missing.js cpuscan.js lastframe.js slpzimport.js overview.js prefilter.js seek.js selection.js remove.js; do
  OUT="$OUT" NODE_PATH="$OUT/out:$PWD/release/app/node_modules:$PWD/node_modules" \
    ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron "scripts/worker-check/$check"
done
