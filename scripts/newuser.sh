#!/usr/bin/env bash
#
# Launch Lunar Clipper (dev) as a BRAND-NEW USER.
#
# How: on Linux the app reads its config dir from $XDG_CONFIG_HOME (default
# ~/.config) and its default project dir from $XDG_DATA_HOME (default
# ~/.local/share). This points BOTH at empty /tmp folders, so the app writes a
# fresh default config and behaves exactly like a first-run install. A fresh
# sandbox is created every time, so it's always a clean first-run.
#
# Your real ~/.config/lm-clipper and your projects are NEVER touched.
# Switch back any time with:  ./scripts/realuser.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_CONFIG="/tmp/lunar-newuser"
SANDBOX_DATA="/tmp/lunar-newuser-data"
REAL_SLIPPI="$HOME/.config/Slippi Launcher"

# Mop up any stray dev instance (Ctrl+C your running 'npm run start' first).
pkill -f electronmon >/dev/null 2>&1 || true

# Fresh first-run every launch.
rm -rf "$SANDBOX_CONFIG" "$SANDBOX_DATA"
mkdir -p "$SANDBOX_CONFIG" "$SANDBOX_DATA/Documents"

# New projects now save under Documents. Redirect the sandbox's Documents into
# /tmp too (Electron reads $XDG_CONFIG_HOME/user-dirs.dirs for it) so test
# projects don't land in your real ~/Documents.
printf 'XDG_DOCUMENTS_DIR="%s/Documents"\n' "$SANDBOX_DATA" \
  > "$SANDBOX_CONFIG/user-dirs.dirs"

# Symlink your real Slippi Launcher into the sandbox so Dolphin auto-detect
# works (a real new user who has Slippi installed would auto-detect too).
# Delete this symlink if you'd rather test the "not set up" state.
if [ -d "$REAL_SLIPPI" ]; then
  ln -s "$REAL_SLIPPI" "$SANDBOX_CONFIG/Slippi Launcher"
fi

echo "▶ NEW USER  (sandbox: $SANDBOX_CONFIG)"
echo "  Your real config + projects are untouched. Back to real: ./scripts/realuser.sh"
cd "$REPO_DIR"
exec env XDG_CONFIG_HOME="$SANDBOX_CONFIG" XDG_DATA_HOME="$SANDBOX_DATA" npm run start
