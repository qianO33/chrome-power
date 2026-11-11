#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const hookPath = resolve(
  process.env.CHROME_POWER_HOOK_PATH ??
    resolve(repoRoot, ".git", "hooks", "post-commit")
)
const marker = "chrome-power-global-deploy-hook"
const legacyMarker = "chrome-power-codex-deploy-hook"
const hook = `#!/bin/sh
# ${marker}
# Deploy the committed runtime and synchronize all supported user-level Skills.
set -eu

cd "$(git rev-parse --show-toplevel)"

if [ "\${CHROME_POWER_SKIP_GLOBAL_DEPLOY:-}" = "1" ] || [ "\${CHROME_POWER_SKIP_CODEX_DEPLOY:-}" = "1" ]; then
  exit 0
fi

node scripts/deploy-codex-global.mjs --quiet --write-config --sync-claude --sync-zcode
`

if (existsSync(hookPath)) {
  const existing = readFileSync(hookPath, "utf8")
  if (!existing.includes(marker) && !existing.includes(legacyMarker)) {
    throw new Error(
      `Refusing to overwrite existing post-commit hook at ${hookPath}`
    )
  }
}

writeFileSync(hookPath, hook)
await chmod(hookPath, 0o755)
console.log(`Installed ${hookPath}`)
