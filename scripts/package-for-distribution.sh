#!/bin/bash
# Package chrome-power MCP server for offline distribution.
# Produces dist-pkg/ containing the built server, production node_modules,
# the agent skill, and an INSTALL.md for the receiver.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-pkg"
APP="$OUT/chrome-power-mcp"
SMOKE="${SKIP_SMOKE:-0}"

cd "$ROOT"

echo "==> [1/5] build"
node --stack-size=8192 node_modules/typescript/bin/tsc -p tsconfig.json

echo "==> [2/5] smoke (SKIP_SMOKE=1 to skip)"
if [ "$SMOKE" != "1" ]; then
  node dist/cli/smoke.js > /dev/null
  echo "    smoke passed"
else
  echo "    skipped"
fi

echo "==> [3/5] stage app"
rm -rf "$OUT"
mkdir -p "$APP" "$OUT/skills"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '*.tsbuildinfo' \
  dist/ "$APP/dist/"
cp package.json "$APP/package.json"
# Ship the repo lockfile so the receiver installs exactly the dependency set
# this build was tested against (e.g. playwright 1.61.1 and its matching
# Chromium build), not whatever is newest at install time.
cp pnpm-lock.yaml "$APP/pnpm-lock.yaml"

echo "==> [4/5] install production dependencies"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm is required (npm i -g pnpm)" >&2
  exit 1
fi
# node-linker=hoisted installs a flat, symlink-free node_modules (real files),
# so the package survives zip/tar transfer and plain `node` resolution.
pnpm install --dir "$APP" --prod --ignore-scripts --frozen-lockfile \
  --config.node-linker=hoisted

echo "==> [5/5] copy skill + INSTALL.md"
cp -R skills/chrome-power-browser "$OUT/skills/chrome-power-browser"
cp scripts/INSTALL.md "$OUT/INSTALL.md"

SIZE=$(du -sh "$OUT" | cut -f1)
cat <<EOF

Done. Output: $OUT  ($SIZE)

Distribute it with:
  cd "$OUT" && zip -r ../chrome-power-mcp.zip . && cd -

Receiver unpacks, then runs (inside chrome-power-mcp/):
  ./node_modules/.bin/playwright install chromium
EOF
