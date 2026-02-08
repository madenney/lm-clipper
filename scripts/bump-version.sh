#!/usr/bin/env bash
set -euo pipefail

# Syncs version across root and release/app package.json files.
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.3.0

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.3.0"
  exit 1
fi

VERSION="$1"

# Validate semver format (basic check)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "Error: Version must be in semver format (e.g. 0.3.0)"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Update root package.json
cd "$ROOT_DIR"
npm version "$VERSION" --no-git-tag-version

# Update release/app/package.json
cd "$ROOT_DIR/release/app"
npm version "$VERSION" --no-git-tag-version

echo "Version updated to $VERSION in both package.json files."
