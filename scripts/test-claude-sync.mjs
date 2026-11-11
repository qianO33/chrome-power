#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { syncClaudeGlobal } from "./sync-claude-global.mjs"
import { directoryDigest } from "./sync-global-skills.mjs"

const root = mkdtempSync(join(tmpdir(), "chrome-power-claude-sync-test-"))

try {
  const fixture = createFixture(root)
  const first = runSync(fixture)
  assert.equal(first.skipped, false)
  assert.equal(first.skillStatus, "updated")
  assert.equal(first.skillDigest, directoryDigest(fixture.skillSourceDir))
  assertRegistration(fixture, fixture.wrapperPath)
  assert.equal(
    readFileSync(join(fixture.skillInstallDir, "SKILL.md"), "utf8"),
    "fixture skill\n"
  )

  const firstConfig = readFileSync(fixture.configPath, "utf8")
  const repeated = runSync(fixture)
  assert.equal(repeated.skillStatus, "unchanged")
  assert.equal(
    repeated.skillDigest,
    directoryDigest(fixture.skillInstallDir)
  )
  assert.equal(readFileSync(fixture.configPath, "utf8"), firstConfig)

  writeConfig(fixture.configPath, {
    mcpServers: {
      "chrome-power": {
        type: "stdio",
        command: "/tmp/stale-chrome-power",
        args: ["old"],
        env: { OLD: "1" },
      },
    },
  })
  runSync(fixture)
  assertRegistration(fixture, fixture.wrapperPath)

  const rollbackConfig = JSON.stringify(
    {
      unrelated: true,
      mcpServers: {
        "chrome-power": {
          type: "stdio",
          command: "/tmp/restore-me",
          args: [],
          env: {},
        },
      },
    },
    null,
    2
  ) + "\n"
  writeFileSync(fixture.configPath, rollbackConfig)
  assert.throws(
    () =>
      runSync(fixture, {
        FAKE_CLAUDE_FAIL_ADD: "1",
      }),
    /previous Claude MCP configuration was restored/
  )
  assert.equal(readFileSync(fixture.configPath, "utf8"), rollbackConfig)

  const skillFailure = createFixture(join(root, "skill-failure"))
  const skillFailureConfig = JSON.stringify(
    {
      mcpServers: {
        "chrome-power": {
          type: "stdio",
          command: "/tmp/skill-rollback",
          args: [],
          env: {},
        },
      },
    },
    null,
    2
  ) + "\n"
  mkdirSync(skillFailure.claudeHome, { recursive: true })
  writeFileSync(skillFailure.configPath, skillFailureConfig)
  mkdirSync(join(skillFailure.claudeHome, ".claude"), { recursive: true })
  writeFileSync(join(skillFailure.claudeHome, ".claude", "skills"), "blocked\n")
  assert.throws(
    () => runSync(skillFailure),
    /previous Claude MCP configuration was restored/
  )
  assert.equal(
    readFileSync(skillFailure.configPath, "utf8"),
    skillFailureConfig
  )

  assert.throws(
    () =>
      syncClaudeGlobal({
        ...fixture.options,
        claudeCommand: join(root, "missing-claude"),
      }),
    /ENOENT|spawnSync/
  )

  const skipped = syncClaudeGlobal({
    ...fixture.options,
    claudeCommand: join(root, "missing-claude"),
    env: {
      ...fixture.options.env,
      CHROME_POWER_SKIP_CLAUDE_DEPLOY: "1",
    },
  })
  assert.deepEqual(skipped, { skipped: true })

  testSymlinkedCliEntry(root)
  testHookInstaller(root)

  console.log(
    JSON.stringify(
      {
        ok: true,
        firstInstall: true,
        idempotentRepeat: true,
        staleReplacement: true,
        rollback: true,
        skillFailureRollback: true,
        skillDigestValidation: true,
        missingCli: true,
        explicitSkip: true,
        symlinkedCliEntry: true,
        hookInstaller: true,
      },
      null,
      2
    )
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

function createFixture(root) {
  const claudeHome = join(root, "home")
  const configPath = join(claudeHome, ".claude.json")
  const skillSourceDir = join(root, "skill-source")
  const skillInstallDir = join(
    claudeHome,
    ".claude",
    "skills",
    "chrome-power-browser"
  )
  const wrapperPath = join(root, "chrome-power-mcp")
  const claudeCommand = join(root, "fake-claude")
  mkdirSync(skillSourceDir, { recursive: true })
  writeFileSync(join(skillSourceDir, "SKILL.md"), "fixture skill\n")
  writeFileSync(wrapperPath, "#!/bin/sh\nexit 0\n")
  chmodSync(wrapperPath, 0o755)
  writeFileSync(claudeCommand, fakeClaudeScript())
  chmodSync(claudeCommand, 0o755)

  return {
    claudeHome,
    configPath,
    skillSourceDir,
    skillInstallDir,
    wrapperPath,
    options: {
      claudeCommand,
      claudeHome,
      configPath,
      skillSourceDir,
      skillInstallDir,
      mcpCommandPath: wrapperPath,
      validationCwd: root,
      quiet: true,
      env: { ...process.env, HOME: claudeHome },
    },
  }
}

function testSymlinkedCliEntry(root) {
  const fixture = createFixture(join(root, "symlink-entry"))
  const scriptAlias = join(root, "scripts-alias")
  symlinkSync(fileURLToPath(new URL(".", import.meta.url)), scriptAlias, "dir")
  const result = spawnSync(
    process.execPath,
    [join(scriptAlias, "sync-claude-global.mjs"), "--quiet"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...fixture.options.env,
        CHROME_POWER_SKIP_CLAUDE_DEPLOY: "0",
        CHROME_POWER_CLAUDE_BIN: fixture.options.claudeCommand,
        CHROME_POWER_CLAUDE_HOME: fixture.claudeHome,
        CHROME_POWER_CLAUDE_CONFIG: fixture.configPath,
        CHROME_POWER_CLAUDE_SKILL_SOURCE: fixture.skillSourceDir,
        CHROME_POWER_CLAUDE_SKILL_DIR: fixture.skillInstallDir,
        CHROME_POWER_CLAUDE_MCP_COMMAND: fixture.wrapperPath,
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    existsSync(fixture.configPath),
    true,
    "symlinked CLI invocation must execute synchronization"
  )
  assertRegistration(fixture, fixture.wrapperPath)
  assert.equal(
    directoryDigest(fixture.skillInstallDir),
    directoryDigest(fixture.skillSourceDir)
  )
}

function testHookInstaller(root) {
  const hookPath = join(root, "hooks", "post-commit")
  mkdirSync(dirname(hookPath), { recursive: true })
  runHookInstaller(hookPath)
  const installed = readFileSync(hookPath, "utf8")
  assert.match(installed, /chrome-power-global-deploy-hook/)
  assert.match(installed, /--write-config --sync-claude --sync-zcode/)
  assert.match(installed, /CHROME_POWER_SKIP_GLOBAL_DEPLOY/)

  writeFileSync(hookPath, "#!/bin/sh\n# chrome-power-codex-deploy-hook\n")
  runHookInstaller(hookPath)
  assert.match(readFileSync(hookPath, "utf8"), /--sync-claude --sync-zcode/)

  writeFileSync(hookPath, "#!/bin/sh\necho unrelated\n")
  const rejected = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts", "install-codex-post-commit-hook.mjs")],
    {
      env: { ...process.env, CHROME_POWER_HOOK_PATH: hookPath },
      encoding: "utf8",
    }
  )
  assert.notEqual(rejected.status, 0)
  assert.equal(readFileSync(hookPath, "utf8"), "#!/bin/sh\necho unrelated\n")
}

function runHookInstaller(hookPath) {
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts", "install-codex-post-commit-hook.mjs")],
    {
      env: { ...process.env, CHROME_POWER_HOOK_PATH: hookPath },
      encoding: "utf8",
    }
  )
  assert.equal(result.status, 0, result.stderr)
}

function runSync(fixture, extraEnv = {}) {
  return syncClaudeGlobal({
    ...fixture.options,
    env: { ...fixture.options.env, ...extraEnv },
  })
}

function assertRegistration(fixture, expectedCommand) {
  const payload = JSON.parse(readFileSync(fixture.configPath, "utf8"))
  assert.deepEqual(payload.mcpServers["chrome-power"], {
    type: "stdio",
    command: expectedCommand,
    args: [],
    env: {},
  })
}

function writeConfig(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`)
}

function fakeClaudeScript() {
  return `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
const configPath = path.join(process.env.HOME, ".claude.json")
const read = () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {}
const write = (value) => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(value, null, 2) + "\\n")
}
if (args[0] === "--version") process.exit(0)
if (args[0] !== "mcp") process.exit(2)
const command = args[1]
const payload = read()
payload.mcpServers ??= {}
if (command === "remove") {
  if (!payload.mcpServers["chrome-power"]) process.exit(1)
  delete payload.mcpServers["chrome-power"]
  write(payload)
  process.exit(0)
}
if (command === "add") {
  if (process.env.FAKE_CLAUDE_FAIL_ADD === "1") process.exit(9)
  const separator = args.indexOf("--")
  payload.mcpServers["chrome-power"] = {
    type: "stdio",
    command: args[separator + 1],
    args: [],
    env: {},
  }
  write(payload)
  process.exit(0)
}
if (command === "get") {
  process.exit(payload.mcpServers["chrome-power"] ? 0 : 1)
}
process.exit(2)
`
}
