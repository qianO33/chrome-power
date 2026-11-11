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

import { syncZcodeGlobal } from "./sync-zcode-global.mjs"
import { directoryDigest } from "./sync-global-skills.mjs"

const root = mkdtempSync(join(tmpdir(), "chrome-power-zcode-sync-test-"))

try {
  const fixture = createFixture(root)
  const first = runSync(fixture)
  assert.equal(first.skipped, false)
  assert.equal(first.skillStatus, "updated")
  assert.equal(first.skillDigest, directoryDigest(fixture.skillSourceDir))
  assertRegistration(fixture, fixture.wrapperPath, { enabled: true })
  assert.equal(
    readFileSync(join(fixture.skillInstallDir, "SKILL.md"), "utf8"),
    "fixture skill\n"
  )
  assert.equal(
    readConfig(fixture.configPath).ui.locale,
    "zh-CN",
    "unrelated config sections must be preserved"
  )

  const firstConfig = readFileSync(fixture.configPath, "utf8")
  const repeated = runSync(fixture)
  assert.equal(repeated.skillStatus, "unchanged")
  assert.equal(
    repeated.skillDigest,
    directoryDigest(fixture.skillInstallDir)
  )
  assert.equal(readFileSync(fixture.configPath, "utf8"), firstConfig)

  const disabledConfig = writeConfigPreserving(fixture, { enabled: false })
  runSync(fixture)
  assert.equal(
    readFileSync(fixture.configPath, "utf8"),
    disabledConfig,
    "a user-disabled registration must be left untouched"
  )
  assertRegistration(fixture, fixture.wrapperPath, { enabled: false })

  writeConfig(fixture.configPath, staleZcodeConfig())
  runSync(fixture)
  assertRegistration(fixture, fixture.wrapperPath, { enabled: true })

  const rollbackConfig = writeRollbackConfig(fixture)
  blockSkillRoot(fixture)
  assert.throws(
    () => runSync(fixture),
    /previous ZCode MCP configuration was restored/
  )
  assert.equal(readFileSync(fixture.configPath, "utf8"), rollbackConfig)

  assert.throws(
    () =>
      syncZcodeGlobal({
        ...fixture.options,
        mcpCommandPath: join(root, "missing-wrapper"),
      }),
    /deployed MCP wrapper does not exist/
  )

  const skipped = syncZcodeGlobal({
    ...fixture.options,
    env: { ...fixture.options.env, CHROME_POWER_SKIP_ZCODE_DEPLOY: "1" },
  })
  assert.deepEqual(skipped, { skipped: true })

  testSymlinkedCliEntry(root)

  console.log(
    JSON.stringify(
      {
        ok: true,
        firstInstall: true,
        idempotentRepeat: true,
        userDisabledPreserved: true,
        staleReplacement: true,
        skillFailureRollback: true,
        skillDigestValidation: true,
        missingWrapper: true,
        explicitSkip: true,
        symlinkedCliEntry: true,
      },
      null,
      2
    )
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

function createFixture(root) {
  const zcodeHome = join(root, "home")
  const configPath = join(zcodeHome, ".zcode", "cli", "config.json")
  const skillSourceDir = join(root, "skill-source")
  const skillInstallDir = join(
    zcodeHome,
    ".zcode",
    "skills",
    "chrome-power-browser"
  )
  const wrapperPath = join(root, "chrome-power-mcp")
  mkdirSync(skillSourceDir, { recursive: true })
  writeFileSync(join(skillSourceDir, "SKILL.md"), "fixture skill\n")
  writeFileSync(wrapperPath, "#!/bin/sh\nexit 0\n")
  chmodSync(wrapperPath, 0o755)
  writeConfig(configPath, { ui: { locale: "zh-CN" } })

  return {
    zcodeHome,
    configPath,
    skillSourceDir,
    skillInstallDir,
    wrapperPath,
    options: {
      zcodeHome,
      configPath,
      skillSourceDir,
      skillInstallDir,
      mcpCommandPath: wrapperPath,
      quiet: true,
      env: { ...process.env, HOME: zcodeHome },
    },
  }
}

function testSymlinkedCliEntry(root) {
  const fixture = createFixture(join(root, "symlink-entry"))
  const scriptAlias = join(root, "scripts-alias")
  symlinkSync(fileURLToPath(new URL(".", import.meta.url)), scriptAlias, "dir")
  const result = spawnSync(
    process.execPath,
    [join(scriptAlias, "sync-zcode-global.mjs"), "--quiet"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...fixture.options.env,
        CHROME_POWER_SKIP_ZCODE_DEPLOY: "0",
        CHROME_POWER_ZCODE_HOME: fixture.zcodeHome,
        CHROME_POWER_ZCODE_CONFIG: fixture.configPath,
        CHROME_POWER_ZCODE_SKILL_SOURCE: fixture.skillSourceDir,
        CHROME_POWER_ZCODE_SKILL_DIR: fixture.skillInstallDir,
        CHROME_POWER_ZCODE_MCP_COMMAND: fixture.wrapperPath,
      },
    }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    existsSync(fixture.configPath),
    true,
    "symlinked CLI invocation must execute synchronization"
  )
  assertRegistration(fixture, fixture.wrapperPath, { enabled: true })
  assert.equal(
    directoryDigest(fixture.skillInstallDir),
    directoryDigest(fixture.skillSourceDir)
  )
}

function runSync(fixture) {
  return syncZcodeGlobal({
    ...fixture.options,
    env: { ...fixture.options.env },
  })
}

function assertRegistration(fixture, expectedCommand, { enabled }) {
  const payload = readConfig(fixture.configPath)
  assert.deepEqual(payload.mcp.servers["chrome-power"], {
    type: "stdio",
    command: expectedCommand,
    args: [],
    enabled,
  })
}

function writeConfig(configPath, payload) {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`)
}

function writeConfigPreserving(fixture, changes) {
  const payload = readConfig(fixture.configPath)
  Object.assign(payload.mcp.servers["chrome-power"], changes)
  const rendered = `${JSON.stringify(payload, null, 2)}\n`
  writeFileSync(fixture.configPath, rendered)
  return rendered
}

function writeRollbackConfig(fixture) {
  const payload = {
    ui: { locale: "zh-CN" },
    mcp: {
      servers: {
        "chrome-power": {
          type: "stdio",
          command: "/tmp/restore-me",
          args: [],
          enabled: true,
        },
      },
    },
  }
  const rendered = `${JSON.stringify(payload, null, 2)}\n`
  writeFileSync(fixture.configPath, rendered)
  return rendered
}

function blockSkillRoot(fixture) {
  mkdirSync(join(fixture.zcodeHome, ".zcode"), { recursive: true })
  rmSync(join(fixture.zcodeHome, ".zcode", "skills"), {
    recursive: true,
    force: true,
  })
  writeFileSync(join(fixture.zcodeHome, ".zcode", "skills"), "blocked\n")
}

function readConfig(configPath) {
  return JSON.parse(readFileSync(configPath, "utf8"))
}

function staleZcodeConfig() {
  return {
    ui: { locale: "zh-CN" },
    mcp: {
      servers: {
        "chrome-power": {
          type: "stdio",
          command: "/tmp/stale-chrome-power",
          args: ["old"],
          env: { OLD: "1" },
          enabled: true,
        },
      },
    },
  }
}
