#!/usr/bin/env bash
#
# Launch Lunar Clipper (dev) with YOUR REAL config + currently-open project.
#
# This is just a normal dev launch with no overrides, so the app reads your
# actual ~/.config/lm-clipper and reopens your current project. Nothing was
# ever changed by the new-user sandbox, so there's nothing to "restore" — this
# simply runs the app as your real self.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mop up any stray dev instance (Ctrl+C your running 'npm run start' first).
pkill -f electronmon >/dev/null 2>&1 || true

echo "▶ REAL  (~/.config/lm-clipper + your open project)"
cd "$REPO_DIR"
exec npm run start
