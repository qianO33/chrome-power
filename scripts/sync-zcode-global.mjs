#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  resolveRegisteredSkillTarget,
  syncSkillDirectory,
} from "./sync-global-skills.mjs"

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), "..")

export function syncZcodeGlobal(options = {}) {
  const environment = options.env ?? process.env
  if (environment.CHROME_POWER_SKIP_ZCODE_DEPLOY === "1") {
    return { skipped: true }
  }

  const quiet =
    options.quiet ??
    (environment.CHROME_POWER_ZCODE_PRINT_CONFIG === "0" ||
      process.argv.includes("--quiet"))
  const zcodeHome = resolve(
    options.zcodeHome ??
      environment.CHROME_POWER_ZCODE_HOME ??
      environment.HOME ??
      homedir()
  )
  const configPath = resolve(
    options.configPath ??
      environment.CHROME_POWER_ZCODE_CONFIG ??
      join(zcodeHome, ".zcode", "cli", "config.json")
  )
  const skillSourceDir = resolve(
    options.skillSourceDir ??
      environment.CHROME_POWER_ZCODE_SKILL_SOURCE ??
      join(repoRoot, "skills", "chrome-power-browser")
  )
  const skillInstallDir = resolve(
    options.skillInstallDir ??
      environment.CHROME_POWER_ZCODE_SKILL_DIR ??
      resolveRegisteredSkillTarget("zcode", zcodeHome)
  )
  const mcpCommandPath = resolve(
    options.mcpCommandPath ??
      environment.CHROME_POWER_ZCODE_MCP_COMMAND ??
      join(
        homedir(),
        ".chrome-power",
        "bin",
        "chrome-power-mcp"
      )
  )

  assertPathExists(mcpCommandPath, "deployed MCP wrapper")
  assertPathExists(skillSourceDir, "ZCode skill source")

  const configSnapshot = snapshotFile(configPath)
  let skillSync
  try {
    synchronizeMcpRegistration({ configPath, mcpCommandPath })
    skillSync = syncSkillDirectory({
      sourceDir: skillSourceDir,
      targetDir: skillInstallDir,
      testHooks: options.testHooks,
    })
  } catch (error) {
    restoreFile(configPath, configSnapshot)
    throw new Error(
      `ZCode synchronization failed; the previous ZCode MCP configuration was restored. ${errorMessage(error)}`
    )
  }

  if (!quiet) {
    console.log(`Updated ZCode MCP server: chrome-power -> ${mcpCommandPath}`)
    console.log(`Updated ZCode skill at ${skillInstallDir}`)
  }

  return {
    skipped: false,
    configPath,
    skillInstallDir,
    skillDigest: skillSync.digest,
    skillStatus: skillSync.status,
    mcpCommandPath,
  }
}

function synchronizeMcpRegistration({ configPath, mcpCommandPath }) {
  const current = readUserMcpRegistration(configPath)
  if (!isExpectedRegistration(current, mcpCommandPath)) {
    writeMcpRegistration({ configPath, mcpCommandPath })
  }

  const finalRegistration = readUserMcpRegistration(configPath)
  if (
    !isPlainObject(finalRegistration) ||
    finalRegistration.type !== "stdio" ||
    finalRegistration.command !== mcpCommandPath ||
    !Array.isArray(finalRegistration.args) ||
    finalRegistration.args.length !== 0
  ) {
    throw new Error(
      `${configPath} does not contain the expected ZCode chrome-power MCP registration`
    )
  }
}

// A registration is expected when it points at the stable wrapper as a stdio
// server. A user-disabled entry (or one with extra UI fields) still matches,
// so repeated synchronization leaves it untouched and byte-stable; only a
// changed wrapper path or transport replaces the whole entry.
function isExpectedRegistration(registration, mcpCommandPath) {
  return (
    isPlainObject(registration) &&
    registration.command === mcpCommandPath &&
    registration.type === "stdio"
  )
}

function readUserMcpRegistration(configPath) {
  if (!existsSync(configPath)) return undefined
  const payload = readConfig(configPath)
  if (!isPlainObject(payload.mcp)) return undefined
  if (!isPlainObject(payload.mcp.servers)) {
    throw new Error(`${configPath} field "mcp.servers" must be an object`)
  }
  return payload.mcp.servers["chrome-power"]
}

function writeMcpRegistration({ configPath, mcpCommandPath }) {
  const payload = existsSync(configPath) ? readConfig(configPath) : {}
  payload.mcp ??= {}
  payload.mcp.servers ??= {}
  payload.mcp.servers["chrome-power"] = {
    type: "stdio",
    command: mcpCommandPath,
    args: [],
    enabled: true,
  }
  writeConfigAtomic(configPath, payload)
}

function readConfig(configPath) {
  let payload
  try {
    payload = JSON.parse(readFileSync(configPath, "utf8"))
  } catch (error) {
    throw new Error(`${configPath} is not valid JSON: ${errorMessage(error)}`)
  }
  if (!isPlainObject(payload)) {
    throw new Error(`${configPath} must contain a JSON object`)
  }
  return payload
}

function writeConfigAtomic(configPath, payload) {
  writeBufferAtomic(configPath, `${JSON.stringify(payload, null, 2)}\n`)
}

function snapshotFile(path) {
  return existsSync(path)
    ? { existed: true, content: readFileSync(path) }
    : { existed: false, content: undefined }
}

function restoreFile(snapshotPath, snapshot) {
  if (!snapshot.existed) {
    rmSync(snapshotPath, { force: true })
    return
  }
  writeBufferAtomic(snapshotPath, snapshot.content)
}

function writeBufferAtomic(path, content) {
  const temporaryPath = siblingTemporaryPath(path, "write")
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(temporaryPath, content)
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function siblingTemporaryPath(path, kind) {
  return join(
    dirname(path),
    `.${basename(path)}.${kind}-${process.pid}-${Date.now()}`
  )
}

function assertPathExists(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist at ${path}`)
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

if (isMainModule()) {
  try {
    syncZcodeGlobal()
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}

function isMainModule() {
  const entryPath = process.argv[1]
  return Boolean(
    entryPath && realpathSync(resolve(entryPath)) === realpathSync(scriptPath)
  )
}
