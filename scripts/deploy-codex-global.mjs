#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { createConnection } from "node:net"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const pluginName = "chrome-power"
const marketplaceNameFallback = "personal"
const args = new Set(process.argv.slice(2))
const quiet =
  args.has("--quiet") || process.env.CHROME_POWER_CODEX_PRINT_CONFIG === "0"
const writeConfig =
  args.has("--write-config") ||
  process.env.CHROME_POWER_CODEX_WRITE_CONFIG === "1"
const writeLegacyMcpConfig =
  writeConfig && process.env.CHROME_POWER_CODEX_WRITE_LEGACY_MCP !== "0"
const mcpAppsFeatureSetting = process.env.CHROME_POWER_CODEX_ENABLE_MCP_APPS
const shouldWriteMcpAppsFeature =
  writeConfig && mcpAppsFeatureSetting !== "skip"
const enableMcpAppsFeature =
  writeConfig &&
  (mcpAppsFeatureSetting === "1" ||
    mcpAppsFeatureSetting === "true" ||
    (mcpAppsFeatureSetting === undefined && !writeLegacyMcpConfig))
const installPlugin =
  writeConfig && process.env.CHROME_POWER_CODEX_INSTALL_PLUGIN !== "0"
const syncClaudeRequested =
  args.has("--sync-claude") ||
  process.env.CHROME_POWER_SYNC_CLAUDE === "1"
const skipClaude = process.env.CHROME_POWER_SKIP_CLAUDE_DEPLOY === "1"
const syncClaude = syncClaudeRequested && !skipClaude
const syncZcodeRequested =
  args.has("--sync-zcode") ||
  process.env.CHROME_POWER_SYNC_ZCODE === "1"
const skipZcode = process.env.CHROME_POWER_SKIP_ZCODE_DEPLOY === "1"
const syncZcode = syncZcodeRequested && !skipZcode
const deployRootOverride = process.env.CHROME_POWER_CODEX_DEPLOY_DIR
const deployRoot = resolve(
  deployRootOverride ?? join(homedir(), ".chrome-power")
)
const codexConfigPath = resolve(
  process.env.CHROME_POWER_CODEX_CONFIG ??
    join(homedir(), ".codex", "config.toml")
)
const pluginDir = resolve(
  process.env.CHROME_POWER_CODEX_PLUGIN_DIR ??
    (deployRootOverride
      ? join(deployRoot, "plugin")
      : join(homedir(), "plugins", pluginName))
)
const globalSkillHome = resolve(
  process.env.CHROME_POWER_GLOBAL_SKILL_HOME ??
    (deployRootOverride ? join(deployRoot, "agent-home") : homedir())
)
const legacyCodexSkillDir = resolve(
  process.env.CHROME_POWER_LEGACY_CODEX_SKILL_DIR ??
    process.env.CHROME_POWER_CODEX_SKILL_DIR ??
    (deployRootOverride && !process.env.CHROME_POWER_GLOBAL_SKILL_HOME
      ? join(deployRoot, "skills", "chrome-power-browser")
      : join(
          globalSkillHome,
          ".codex",
          "skills",
          "chrome-power-browser"
        ))
)
const marketplacePath = resolve(
  process.env.CHROME_POWER_CODEX_MARKETPLACE ??
    join(homedir(), ".agents", "plugins", "marketplace.json")
)
const marketplaceSourcePath =
  process.env.CHROME_POWER_CODEX_MARKETPLACE_SOURCE_PATH ??
  `./plugins/${pluginName}`
const appDir = join(deployRoot, "app")
const binDir = join(deployRoot, "bin")
const mcpCommandPath = join(binDir, "chrome-power-mcp")
const pnpmStoreDir = join(deployRoot, "pnpm-store")
const profileDir = join(deployRoot, "profile")
const screenshotDir = join(deployRoot, "artifacts", "screenshots")
const downloadDir = join(deployRoot, "artifacts", "downloads")
const ownerSocketPath = resolve(
  process.env.CHROME_POWER_OWNER_SOCKET ??
    join(
      dirname(profileDir),
      `chrome-power-owner-${createHash("sha256").update(profileDir).digest("hex").slice(0, 12)}.sock`
    )
)
const ownerControlPath = `${ownerSocketPath}.control.json`
const ownerEndpoint = process.env.CHROME_POWER_OWNER_PORT
  ? {
      kind: "tcp",
      host: process.env.CHROME_POWER_OWNER_HOST ?? "127.0.0.1",
      port: Number(process.env.CHROME_POWER_OWNER_PORT),
    }
  : { kind: "socket", path: ownerSocketPath }
const mcpConfigBlock = `[mcp_servers.chrome-power]
type = "stdio"
command = "${mcpCommandPath}"
args = []
cwd = "${appDir}"`

const tmpRoot = mkdtempSync(join(tmpdir(), "chrome-power-deploy-"))
const sourceDir = join(tmpRoot, "source")
const stagingDir = join(
  deployRoot,
  `.app-staging-${process.pid}-${Date.now()}`
)
const backupDir = join(
  deployRoot,
  `.app-backup-${process.pid}-${Date.now()}`
)
const archivePath = join(tmpRoot, "source.tar")

try {
  let installedPluginSelector = null
  let globalSkillSyncResult = null

  mkdirSync(deployRoot, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  rmSync(stagingDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })
  mkdirSync(pnpmStoreDir, { recursive: true })

  const commit = run("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    capture: true,
  })

  run("git", ["archive", "--format=tar", "HEAD", "-o", archivePath], {
    cwd: repoRoot,
  })
  run("tar", ["-xf", archivePath, "-C", sourceDir])
  run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--store-dir",
      pnpmStoreDir,
    ],
    { cwd: sourceDir }
  )
  run("pnpm", ["build"], { cwd: sourceDir })

  cpSync(join(sourceDir, "package.json"), join(stagingDir, "package.json"))
  cpSync(join(sourceDir, "pnpm-lock.yaml"), join(stagingDir, "pnpm-lock.yaml"))
  cpSync(join(sourceDir, "README.md"), join(stagingDir, "README.md"))
  cpSync(join(sourceDir, "dist"), join(stagingDir, "dist"), {
    recursive: true,
  })
  writeFileSync(join(stagingDir, "DEPLOYED_COMMIT"), `${commit}\n`)
  run(
    "pnpm",
    [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--prefer-offline",
      "--store-dir",
      pnpmStoreDir,
    ],
    { cwd: stagingDir }
  )
  verifyChromiumReadiness(stagingDir)

  const packageVersion = readPackageVersion(join(sourceDir, "package.json"))
  const pluginVersion = toCodexPluginVersion(packageVersion, commit)
  const skillSourceDir = join(sourceDir, "skills", "chrome-power-browser")

  mkdirSync(binDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(screenshotDir, { recursive: true })
  mkdirSync(downloadDir, { recursive: true })
  await replaceDeployedApp(commit)
  writeMcpCommandWrapper()

  writeChromePowerPlugin({
    pluginDir,
    skillSourceDir,
    pluginVersion,
    commit,
  })
  globalSkillSyncResult = JSON.parse(
    run(
      process.execPath,
      [join(sourceDir, "scripts", "sync-global-skills.mjs"), "--json"],
      {
        cwd: appDir,
        env: {
          ...process.env,
          HOME: globalSkillHome,
          CHROME_POWER_GLOBAL_SKILL_HOME: globalSkillHome,
          CHROME_POWER_SKILL_SOURCE: skillSourceDir,
          CHROME_POWER_LEGACY_CODEX_SKILL_DIR: legacyCodexSkillDir,
        },
        capture: true,
      }
    )
  )

  if (writeConfig) {
    if (writeLegacyMcpConfig) {
      writeCodexMcpConfig(codexConfigPath, mcpConfigBlock)
    } else {
      removeCodexMcpConfig(codexConfigPath)
    }
    if (shouldWriteMcpAppsFeature) {
      writeCodexFeatureFlag(
        codexConfigPath,
        "enable_mcp_apps",
        enableMcpAppsFeature
      )
    }

    const marketplaceName = writeCodexPluginMarketplace({
      marketplacePath,
      pluginName,
      sourcePath: marketplaceSourcePath,
    })

    if (installPlugin) {
      installedPluginSelector = `${pluginName}@${marketplaceName}`
      installCodexPlugin(installedPluginSelector)
    }
  }

  if (syncClaude) {
    const claudeHome = resolve(
      process.env.CHROME_POWER_CLAUDE_HOME ??
        (deployRootOverride ? join(deployRoot, "claude-home") : homedir())
    )
    run(
      process.execPath,
      [join(sourceDir, "scripts", "sync-claude-global.mjs"), "--quiet"],
      {
        cwd: appDir,
        env: {
          ...process.env,
          HOME: claudeHome,
          CHROME_POWER_CLAUDE_HOME: claudeHome,
          CHROME_POWER_CLAUDE_MCP_COMMAND: mcpCommandPath,
          CHROME_POWER_CLAUDE_MCP_CWD: appDir,
          CHROME_POWER_CLAUDE_SKILL_SOURCE: skillSourceDir,
        },
        capture: true,
      }
    )
  }

  if (syncZcode) {
    const zcodeHome = resolve(
      process.env.CHROME_POWER_ZCODE_HOME ??
        (deployRootOverride ? join(deployRoot, "zcode-home") : homedir())
    )
    run(
      process.execPath,
      [join(sourceDir, "scripts", "sync-zcode-global.mjs"), "--quiet"],
      {
        cwd: appDir,
        env: {
          ...process.env,
          CHROME_POWER_ZCODE_HOME: zcodeHome,
          CHROME_POWER_ZCODE_MCP_COMMAND: mcpCommandPath,
          CHROME_POWER_ZCODE_SKILL_SOURCE: skillSourceDir,
        },
        capture: true,
      }
    )
  }

  if (!quiet) {
    console.log(`Deployed chrome-power ${commit} to ${appDir}`)
    console.log(`Updated chrome-power MCP command at ${mcpCommandPath}`)
    console.log(`Updated Codex plugin at ${pluginDir}`)
    for (const target of globalSkillSyncResult.targets) {
      console.log(
        `${target.status === "skipped" ? "Skipped" : "Synchronized"} ${target.id} Skill at ${target.path}`
      )
    }
    for (const legacy of globalSkillSyncResult.legacy) {
      console.log(`Legacy ${legacy.id}: ${legacy.status} (${legacy.path})`)
    }
    for (const warning of globalSkillSyncResult.warnings) {
      console.warn(`Skill synchronization warning: ${warning}`)
    }
    if (writeConfig) {
      console.log(`Updated Codex config at ${codexConfigPath}`)
      console.log(`Updated Codex marketplace at ${marketplacePath}`)
      if (installedPluginSelector) {
        console.log(`Installed Codex plugin: ${installedPluginSelector}`)
      }
    }
    if (syncClaude) {
      console.log("Updated Claude Code MCP server and skill")
    } else if (syncClaudeRequested) {
      console.log("Skipped Claude Code synchronization")
    }
    if (syncZcode) {
      console.log("Updated ZCode MCP server and skill")
    } else if (syncZcodeRequested) {
      console.log("Skipped ZCode synchronization")
    }
    console.log("")
    console.log("Codex plugin MCP config:")
    console.log(JSON.stringify(buildMcpManifest(), null, 2))
    if (writeLegacyMcpConfig) {
      console.log("")
      console.log("Legacy Codex MCP config:")
      console.log(mcpConfigBlock)
    }
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
  rmSync(stagingDir, { recursive: true, force: true })
}

function run(command, args, options = {}) {
  const captureOutput = options.capture || quiet
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
  })

  if (result.status !== 0) {
    const rendered = [command, ...args].join(" ")
    const output = [result.stdout, result.stderr]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n")
    throw new Error(
      output ? `${rendered} failed:\n${output}` : `${rendered} failed`
    )
  }

  return result.stdout?.trim() ?? ""
}

async function replaceDeployedApp(commit) {
  const hadPreviousApp = existsSync(appDir)
  if (hadPreviousApp) renameSync(appDir, backupDir)

  try {
    renameSync(stagingDir, appDir)
    validateDeployedApp()
    await rollDeployedOwner(commit)
  } catch (error) {
    rmSync(appDir, { recursive: true, force: true })
    if (hadPreviousApp && existsSync(backupDir)) {
      try {
        renameSync(backupDir, appDir)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Deployment failed and the previous app could not be restored. Backup preserved at ${backupDir}.`
        )
      }
    }
    throw error
  }
  cleanupBackup(backupDir)
}

async function rollDeployedOwner(commit) {
  const deadline = Date.now() + 15_000
  const owners = await discoverManagedOwners(deadline)
  for (const owner of owners) {
    if (!owner.metadata || owner.metadata.deployedCommit === commit) continue
    let stopped = false
    while (Date.now() < deadline) {
      const response = await sendOwnerControlRequest(
        owner.metadata,
        deadline
      )
      if (response?.control?.status === "accepted") {
        await waitForOwnerExit(owner, deadline)
        stopped = true
        break
      }
      if (response?.control?.status !== "busy") {
        throw new Error(
          `Owner rollover was rejected for ${owner.label}: ${response?.error?.message ?? "invalid control response"}`
        )
      }
      await delay(100)
    }
    if (!stopped) {
      throw new Error(
        `Timed out after 15 seconds waiting for ${owner.label} to become idle; deployment did not force-kill active browser work.`
      )
    }
  }
}

async function discoverManagedOwners(deadline) {
  const namespaceRuntime = await import(
    `${pathToFileURL(join(appDir, "dist", "runtime-namespace.js")).href}?deploy=${Date.now()}`
  )
  const owners = [
    {
      label: "the default shared owner",
      namespace: undefined,
      profileDir,
      controlPath: ownerControlPath,
      endpoint: ownerEndpoint,
      allowLegacyWithoutControl: true,
    },
  ]
  const namespaceRoot = join(deployRoot, "namespaces")
  if (existsSync(namespaceRoot)) {
    for (const entry of readdirSync(namespaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const namespace = namespaceRuntime.parseRuntimeNamespace(entry.name)
      const namespaceProfile = namespaceRuntime.namespaceProfileDir(
        profileDir,
        namespace
      )
      owners.push({
        label: `namespace owner ${JSON.stringify(namespace)}`,
        namespace,
        profileDir: namespaceProfile,
        controlPath:
          namespaceRuntime.namespaceOwnerControlPath(namespaceProfile),
        endpoint: {
          kind: "socket",
          path: namespaceRuntime.namespaceOwnerSocketPath(namespaceProfile),
        },
        allowLegacyWithoutControl: false,
      })
    }
  }

  const discovered = []
  for (const owner of owners) {
    let hasControl = existsSync(owner.controlPath)
    if (
      !hasControl &&
      ((await endpointIsLive(owner.endpoint)) || ownerStartupLockExists(owner))
    ) {
      hasControl = await waitForControlMetadata(owner.controlPath, deadline, 500)
      if (!hasControl) {
        const endpointLive = await endpointIsLive(owner.endpoint)
        if (!endpointLive && !ownerStartupLockExists(owner)) {
          discovered.push({ ...owner, metadata: undefined })
          continue
        }
        const guidance = owner.allowLegacyWithoutControl
          ? "Retire that verified owner once, then retry deployment."
          : "Namespaced owners must publish authenticated control metadata."
        throw new Error(
          `${owner.label} is still live at ${ownerEndpointLabel(owner.endpoint)} but has no authenticated control metadata. ${guidance}`
        )
      }
    }
    if (!hasControl) {
      discovered.push({ ...owner, metadata: undefined })
      continue
    }

    const metadata = readOwnerControlMetadata(owner)
    validateManagedOwnerMetadata(owner, metadata)
    if (!(await endpointIsLive(metadata.endpoint))) {
      rmSync(owner.controlPath, { force: true })
      discovered.push({ ...owner, metadata: undefined })
      continue
    }
    discovered.push({ ...owner, metadata })
  }
  return discovered
}

function ownerStartupLockExists(owner) {
  return (
    owner.endpoint.kind === "socket" &&
    existsSync(`${owner.endpoint.path}.startup-lock`)
  )
}

async function waitForControlMetadata(controlPath, deadline, timeoutMs) {
  const localDeadline = Math.min(deadline, Date.now() + timeoutMs)
  while (Date.now() < localDeadline) {
    if (existsSync(controlPath)) return true
    await delay(25)
  }
  return false
}

function readOwnerControlMetadata(owner) {
  let metadata
  try {
    metadata = JSON.parse(readFileSync(owner.controlPath, "utf8"))
  } catch (error) {
    throw new Error(
      `Unable to read owner control metadata at ${owner.controlPath}: ${errorMessage(error)}`
    )
  }
  if (
    metadata?.version !== 1 ||
    !Number.isInteger(metadata.pid) ||
    typeof metadata.token !== "string" ||
    metadata.token === "" ||
    !metadata.endpoint ||
    (metadata.endpoint.kind !== "socket" && metadata.endpoint.kind !== "tcp") ||
    (metadata.endpoint.kind === "socket" && typeof metadata.endpoint.path !== "string") ||
    (metadata.endpoint.kind === "tcp" &&
      (typeof metadata.endpoint.host !== "string" ||
        !Number.isInteger(metadata.endpoint.port) ||
        metadata.endpoint.port < 1 ||
        metadata.endpoint.port > 65_535))
  ) {
    throw new Error(`Malformed owner control metadata at ${owner.controlPath}.`)
  }
  return metadata
}

function validateManagedOwnerMetadata(owner, metadata) {
  if (
    ownerEndpointLabel(metadata.endpoint) !==
    ownerEndpointLabel(owner.endpoint)
  ) {
    throw new Error(`${owner.label} control endpoint does not match its managed endpoint.`)
  }
  if (
    metadata.ownerEntry !== undefined &&
    (typeof metadata.ownerEntry !== "string" ||
      resolve(metadata.ownerEntry) !== join(appDir, "dist", "owner.js"))
  ) {
    throw new Error(`${owner.label} control owner entry is outside the deployed app.`)
  }
  if (owner.namespace) {
    if (metadata.namespace !== owner.namespace) {
      throw new Error(`${owner.label} control namespace does not match its directory.`)
    }
    if (
      typeof metadata.profileDir !== "string" ||
      resolve(metadata.profileDir) !== owner.profileDir
    ) {
      throw new Error(`${owner.label} control profile does not match its managed profile.`)
    }
    if (typeof metadata.ownerEntry !== "string") {
      throw new Error(`${owner.label} control metadata must identify the deployed owner entry.`)
    }
    return
  }
  if (metadata.namespace !== undefined) {
    throw new Error("The default shared owner control metadata must not declare a namespace.")
  }
  if (
    metadata.profileDir !== undefined &&
    resolve(metadata.profileDir) !== owner.profileDir
  ) {
    throw new Error("The default shared owner control profile does not match this deployment.")
  }
}

async function sendOwnerControlRequest(metadata, deadline) {
  return await sendJsonLine(metadata.endpoint, {
    id: randomUUID(),
    kind: "shutdown",
    sessionId: `deploy-${process.pid}`,
    token: metadata.token,
  }, deadline)
}

async function waitForOwnerExit(owner, deadline) {
  const metadata = owner.metadata
  while (Date.now() < deadline) {
    const live = await endpointIsLive(metadata.endpoint)
    const current = existsSync(owner.controlPath)
      ? readOwnerControlMetadata(owner)
      : undefined
    if (!live && (!current || current.token !== metadata.token)) return
    await delay(50)
  }
  throw new Error(
    `${owner.label} accepted shutdown but did not exit before the shared 15-second deadline.`
  )
}

function sendJsonLine(endpoint, request, deadline) {
  return new Promise((resolvePromise, reject) => {
    const socket = connectOwnerEndpoint(endpoint)
    let buffer = ""
    let settled = false
    socket.setEncoding("utf8")
    socket.setTimeout(Math.max(1, Math.min(2_000, deadline - Date.now())))
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      settled = true
      socket.end()
      try {
        resolvePromise(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    })
    socket.once("timeout", () => {
      socket.destroy()
      reject(new Error("Timed out waiting for owner control response."))
    })
    socket.once("error", reject)
    socket.once("close", () => {
      if (!settled) reject(new Error("Owner control connection closed before a response."))
    })
  })
}

function endpointIsLive(endpoint) {
  return new Promise((resolvePromise) => {
    const socket = connectOwnerEndpoint(endpoint)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(250)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

function connectOwnerEndpoint(endpoint) {
  return endpoint.kind === "socket"
    ? createConnection(endpoint.path)
    : createConnection(endpoint.port, endpoint.host)
}

function ownerEndpointLabel(endpoint) {
  return endpoint.kind === "socket"
    ? resolve(endpoint.path)
    : `${endpoint.host}:${endpoint.port}`
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function validateDeployedApp() {
  const output = run(
    process.execPath,
    [join(appDir, "dist", "cli", "fallback.js"), "status"],
    {
      cwd: appDir,
      capture: true,
      env: {
        ...process.env,
        CHROME_POWER_PROFILE_DIR: profileDir,
        CHROME_POWER_SCREENSHOT_DIR: screenshotDir,
        CHROME_POWER_DOWNLOAD_DIR: downloadDir,
        CHROME_POWER_DIRECT_RUNTIME: "1",
      },
    }
  )
  const result = JSON.parse(output)
  if (result?.ok !== true) {
    throw new Error(`Deployed chrome-power status failed: ${output}`)
  }
}

function verifyChromiumReadiness(appPath) {
  const script = `
import { existsSync } from "node:fs";
import { chromium } from "playwright";
const executable = chromium.executablePath();
if (!existsSync(executable)) {
  throw new Error(
    "Playwright Chromium is missing at " + executable +
    ". Run: pnpm exec playwright install chromium"
  );
}
const browser = await chromium.launch({ channel: "chromium", headless: true });
await browser.close();
`
  try {
    run(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: appPath,
      capture: true,
    })
  } catch (error) {
    throw new Error(
      `Playwright Chromium readiness check failed before deployment. The existing deployed app was not changed. ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function readPackageVersion(packageJsonPath) {
  const payload = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  if (typeof payload.version !== "string" || payload.version.trim() === "") {
    throw new Error(`${packageJsonPath} must contain a string version`)
  }
  return payload.version
}

function toCodexPluginVersion(version, commit) {
  const baseVersion = version.split("+")[0]
  return `${baseVersion}+codex.${commit.slice(0, 12)}`
}

function writeChromePowerPlugin({
  pluginDir,
  skillSourceDir,
  pluginVersion,
  commit,
}) {
  const stagedPluginDir = siblingTemporaryPath(pluginDir, "staging")
  rmSync(stagedPluginDir, { recursive: true, force: true })
  mkdirSync(join(stagedPluginDir, ".codex-plugin"), { recursive: true })
  mkdirSync(join(stagedPluginDir, "skills"), { recursive: true })

  writeJson(join(stagedPluginDir, ".codex-plugin", "plugin.json"), {
    name: pluginName,
    version: pluginVersion,
    description:
      "Standalone Playwright-backed browser automation for Codex through MCP.",
    author: {
      name: "qian",
    },
    license: "MIT",
    keywords: ["browser", "mcp", "playwright", "codex"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    bundledContentVariant: "legacy-mcp",
    interface: {
      displayName: "Chrome Power",
      shortDescription: "Control a standalone Playwright Chromium runtime.",
      longDescription:
        "Chrome Power gives Codex a persistent Playwright Chromium browser with native MCP tools for opening pages, reading snapshots, interacting with elements, inspecting diagnostics, and saving screenshots or downloads.",
      developerName: "qian",
      category: "Engineering",
      capabilities: ["Interactive", "Read", "Write"],
      defaultPrompt: [
        "Open a page with Chrome Power and take a screenshot."
      ],
      brandColor: "#0F766E",
    },
  })
  writeJson(join(stagedPluginDir, ".mcp.json"), buildMcpManifest())
  cpSync(
    skillSourceDir,
    join(stagedPluginDir, "skills", "chrome-power-browser"),
    { recursive: true }
  )
  writeSkillOpenAiMetadata(
    join(stagedPluginDir, "skills", "chrome-power-browser")
  )
  writeFileSync(join(stagedPluginDir, "DEPLOYED_COMMIT"), `${commit}\n`)
  replaceOwnedDirectory(stagedPluginDir, pluginDir)
}

function buildMcpManifest() {
  return {
    mcpServers: {
      [pluginName]: {
        command: mcpCommandPath,
        args: [],
        cwd: appDir,
      },
    },
  }
}

function writeMcpCommandWrapper() {
  const script = `#!/usr/bin/env sh
set -eu
export CHROME_POWER_PROFILE_DIR="${profileDir}"
export CHROME_POWER_SCREENSHOT_DIR="${screenshotDir}"
export CHROME_POWER_DOWNLOAD_DIR="${downloadDir}"
cd "${appDir}"
exec node "${join(appDir, "dist", "server.js")}"
`
  mkdirSync(binDir, { recursive: true })
  writeTextAtomic(mcpCommandPath, script, 0o755)
}

function writeSkillOpenAiMetadata(skillDir) {
  mkdirSync(join(skillDir, "agents"), { recursive: true })
  writeFileSync(
    join(skillDir, "agents", "openai.yaml"),
    `interface:
  display_name: "Chrome Power Browser"
  short_description: "Control a standalone Playwright Chromium runtime"
  default_prompt: "Use $chrome-power-browser to open a page, inspect it, and take a screenshot with native chrome-power MCP tools."

dependencies:
  tools:
    - type: "mcp"
      value: "chrome-power"
      description: "Chrome Power MCP browser server"
      transport: "stdio"
      command: "${mcpCommandPath}"
`
  )
}

function writeCodexPluginMarketplace({ marketplacePath, pluginName, sourcePath }) {
  const existing = existsSync(marketplacePath)
    ? readJson(marketplacePath)
    : {
        name: marketplaceNameFallback,
        interface: {
          displayName: "Personal",
        },
        plugins: [],
      }

  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`${marketplacePath} must contain a JSON object`)
  }

  const marketplaceName =
    typeof existing.name === "string" && existing.name.trim() !== ""
      ? existing.name
      : marketplaceNameFallback
  existing.name = marketplaceName
  if (existing.interface !== undefined && !isPlainObject(existing.interface)) {
    throw new Error(`${marketplacePath} field "interface" must be an object`)
  }
  existing.interface ??= { displayName: "Personal" }
  if (!Array.isArray(existing.plugins)) {
    throw new Error(`${marketplacePath} field "plugins" must be an array`)
  }

  const entry = {
    name: pluginName,
    source: {
      source: "local",
      path: sourcePath,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Engineering",
  }

  const index = existing.plugins.findIndex(
    (candidate) => isPlainObject(candidate) && candidate.name === pluginName
  )
  if (index >= 0) {
    existing.plugins[index] = entry
  } else {
    existing.plugins.push(entry)
  }

  writeJson(marketplacePath, existing)
  return marketplaceName
}

function installCodexPlugin(selector) {
  run("codex", ["plugin", "add", selector, "--json"], {
    cwd: repoRoot,
    capture: true,
  })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function writeJson(path, payload) {
  writeTextAtomic(path, `${JSON.stringify(payload, null, 2)}\n`)
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function writeCodexMcpConfig(configPath, block) {
  const existing = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : ""
  const withoutExisting = removeTomlTables(existing, [
    "mcp_servers.chrome-power",
    "mcp_servers.chrome-power.env",
  ])
  const lines = withoutExisting.split(/\r?\n/)
  const mcpHeaderIndex = lines.findIndex((line) =>
    /^\s*\[mcp_servers\]\s*$/.test(line)
  )

  let nextContent
  if (mcpHeaderIndex >= 0) {
    lines.splice(mcpHeaderIndex + 1, 0, "", block)
    nextContent = lines.join("\n")
  } else {
    const prefix = withoutExisting.trimEnd()
    nextContent = `${prefix}${prefix ? "\n\n" : ""}[mcp_servers]\n\n${block}\n`
  }

  writeTextAtomic(configPath, `${nextContent.trimEnd()}\n`)
}

function removeCodexMcpConfig(configPath) {
  const existing = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : ""
  const withoutExisting = removeTomlTables(existing, [
    "mcp_servers.chrome-power",
    "mcp_servers.chrome-power.env",
  ])

  if (withoutExisting !== existing || !existsSync(configPath)) {
    writeTextAtomic(configPath, `${withoutExisting.trimEnd()}\n`)
  }
}

function writeCodexFeatureFlag(configPath, key, value) {
  const existing = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : ""
  const lines = existing.split(/\r?\n/)
  const featuresHeaderIndex = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line)
  )
  const rendered = `${key} = ${value ? "true" : "false"}`

  if (featuresHeaderIndex < 0) {
    const prefix = existing.trimEnd()
    const nextContent = `${prefix}${prefix ? "\n\n" : ""}[features]\n${rendered}\n`
    writeTextAtomic(configPath, nextContent)
    return
  }

  let nextTableIndex = lines.length
  for (let index = featuresHeaderIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      nextTableIndex = index
      break
    }
  }

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  const existingKeyIndex = lines.findIndex(
    (line, index) =>
      index > featuresHeaderIndex &&
      index < nextTableIndex &&
      keyPattern.test(line)
  )
  if (existingKeyIndex >= 0) {
    lines[existingKeyIndex] = rendered
  } else {
    lines.splice(nextTableIndex, 0, rendered)
  }

  writeTextAtomic(configPath, `${lines.join("\n").trimEnd()}\n`)
}

function replaceOwnedDirectory(stagedPath, targetPath) {
  const backupPath = siblingTemporaryPath(targetPath, "backup")
  const hadTarget = existsSync(targetPath)
  let completed = false
  rmSync(backupPath, { recursive: true, force: true })
  if (hadTarget) renameSync(targetPath, backupPath)
  try {
    renameSync(stagedPath, targetPath)
    completed = true
  } catch (error) {
    rmSync(targetPath, { recursive: true, force: true })
    if (hadTarget && existsSync(backupPath)) {
      try {
        renameSync(backupPath, targetPath)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Update failed and the previous directory could not be restored. Backup preserved at ${backupPath}.`
        )
      }
    }
    throw error
  } finally {
    rmSync(stagedPath, { recursive: true, force: true })
  }
  if (completed) cleanupBackup(backupPath)
}

function cleanupBackup(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    console.warn(
      `Deployment succeeded but backup cleanup failed at ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function writeTextAtomic(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}`
  )
  try {
    writeFileSync(temporaryPath, content)
    if (mode != null) chmodSync(temporaryPath, mode)
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function siblingTemporaryPath(path, kind) {
  return join(
    dirname(path),
    `.${basename(path)}-${kind}-${process.pid}-${Date.now()}`
  )
}

function removeTomlTables(content, tableNames) {
  const names = new Set(tableNames)
  const lines = content.split(/\r?\n/)
  const kept = []
  let skipping = false

  for (const line of lines) {
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (tableMatch) {
      skipping = names.has(tableMatch[1].trim())
    }
    if (!skipping) {
      kept.push(line)
    }
  }

  return kept.join("\n")
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
