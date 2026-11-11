#!/usr/bin/env node
import { spawnSync } from "node:child_process"
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

export function syncClaudeGlobal(options = {}) {
  const environment = options.env ?? process.env
  if (environment.CHROME_POWER_SKIP_CLAUDE_DEPLOY === "1") {
    return { skipped: true }
  }

  const quiet =
    options.quiet ??
    (environment.CHROME_POWER_CLAUDE_PRINT_CONFIG === "0" ||
      process.argv.includes("--quiet"))
  const claudeHome = resolve(
    options.claudeHome ??
      environment.CHROME_POWER_CLAUDE_HOME ??
      homedir()
  )
  const configPath = resolve(
    options.configPath ??
      environment.CHROME_POWER_CLAUDE_CONFIG ??
      join(claudeHome, ".claude.json")
  )
  const skillSourceDir = resolve(
    options.skillSourceDir ??
      environment.CHROME_POWER_CLAUDE_SKILL_SOURCE ??
      join(repoRoot, "skills", "chrome-power-browser")
  )
  const skillInstallDir = resolve(
    options.skillInstallDir ??
      environment.CHROME_POWER_CLAUDE_SKILL_DIR ??
      resolveRegisteredSkillTarget("claude", claudeHome)
  )
  const mcpCommandPath = resolve(
    options.mcpCommandPath ??
      environment.CHROME_POWER_CLAUDE_MCP_COMMAND ??
      join(
        homedir(),
        ".chrome-power",
        "bin",
        "chrome-power-mcp"
      )
  )
  const validationCwd = resolve(
    options.validationCwd ??
      environment.CHROME_POWER_CLAUDE_MCP_CWD ??
      dirname(mcpCommandPath)
  )
  const claudeCommand =
    options.claudeCommand ??
    environment.CHROME_POWER_CLAUDE_BIN ??
    "claude"
  const commandEnv = { ...environment, HOME: claudeHome }

  assertPathExists(mcpCommandPath, "deployed MCP wrapper")
  assertPathExists(skillSourceDir, "Claude skill source")
  assertClaudeAvailable(claudeCommand, commandEnv, validationCwd)

  const configSnapshot = snapshotFile(configPath)
  let skillSync
  try {
    synchronizeMcpRegistration({
      claudeCommand,
      commandEnv,
      configPath,
      mcpCommandPath,
      validationCwd,
    })
    skillSync = syncSkillDirectory({
      sourceDir: skillSourceDir,
      targetDir: skillInstallDir,
    })
  } catch (error) {
    restoreFile(configPath, configSnapshot)
    throw new Error(
      `Claude Code synchronization failed; the previous Claude MCP configuration was restored. ${errorMessage(error)}`
    )
  }

  if (!quiet) {
    console.log(`Updated Claude Code MCP server: chrome-power -> ${mcpCommandPath}`)
    console.log(`Updated Claude Code skill at ${skillInstallDir}`)
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

function assertClaudeAvailable(command, env, cwd) {
  run(command, ["--version"], { env, cwd, capture: true })
}

function synchronizeMcpRegistration({
  claudeCommand,
  commandEnv,
  configPath,
  mcpCommandPath,
  validationCwd,
}) {
  const current = readUserMcpRegistration(configPath)
  if (!matchesExpectedRegistration(current, mcpCommandPath)) {
    if (current !== undefined) {
      run(
        claudeCommand,
        ["mcp", "remove", "chrome-power", "--scope", "user"],
        { env: commandEnv, cwd: validationCwd, capture: true }
      )
    }
    run(
      claudeCommand,
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "chrome-power",
        "--",
        mcpCommandPath,
      ],
      { env: commandEnv, cwd: validationCwd, capture: true }
    )
  }

  const finalRegistration = readUserMcpRegistration(configPath)
  if (!matchesExpectedRegistration(finalRegistration, mcpCommandPath)) {
    throw new Error(
      `${configPath} does not contain the expected user-scoped chrome-power MCP registration`
    )
  }
  run(claudeCommand, ["mcp", "get", "chrome-power"], {
    env: commandEnv,
    cwd: validationCwd,
    capture: true,
  })
}

function readUserMcpRegistration(configPath) {
  if (!existsSync(configPath)) return undefined
  const payload = JSON.parse(readFileSync(configPath, "utf8"))
  if (!isPlainObject(payload)) {
    throw new Error(`${configPath} must contain a JSON object`)
  }
  if (payload.mcpServers === undefined) return undefined
  if (!isPlainObject(payload.mcpServers)) {
    throw new Error(`${configPath} field "mcpServers" must be an object`)
  }
  return payload.mcpServers["chrome-power"]
}

function matchesExpectedRegistration(registration, command) {
  if (!isPlainObject(registration)) return false
  const args = registration.args ?? []
  const env = registration.env ?? {}
  return (
    registration.type === "stdio" &&
    registration.command === command &&
    Array.isArray(args) &&
    args.length === 0 &&
    isPlainObject(env) &&
    Object.keys(env).length === 0
  )
}

function snapshotFile(path) {
  return existsSync(path)
    ? { existed: true, content: readFileSync(path) }
    : { existed: false, content: undefined }
}

function restoreFile(path, snapshot) {
  if (!snapshot.existed) {
    rmSync(path, { force: true })
    return
  }
  writeBufferAtomic(path, snapshot.content)
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

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n")
    throw new Error(
      `${[command, ...args].join(" ")} failed${output ? `:\n${output}` : ""}`
    )
  }
  return result.stdout?.trim() ?? ""
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(scriptPath)
) {
  syncClaudeGlobal()
}
