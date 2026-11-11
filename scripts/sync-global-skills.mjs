#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), "..")

export const skillName = "chrome-power-browser"

export const globalSkillTargets = Object.freeze([
  {
    id: "agent-skills",
    manager: "global-skills",
    required: true,
    environmentName: "CHROME_POWER_AGENT_SKILL_DIR",
    installSegments: [".agents", "skills", skillName],
    consumers: [
      {
        id: "codex",
        required: true,
        detectionSegments: [[".codex"]],
      },
      {
        id: "gemini",
        detectionSegments: [[".gemini"]],
      },
    ],
  },
  {
    id: "qoder",
    manager: "global-skills",
    required: false,
    environmentName: "CHROME_POWER_QODER_SKILL_DIR",
    installSegments: [".qoder", "skills", skillName],
    consumers: [
      {
        id: "qoder",
        detectionSegments: [[".qoder"]],
      },
      {
        id: "qoder-cn",
        detectionSegments: [[".qoder-cn"]],
      },
    ],
  },
  {
    id: "codebuddy",
    manager: "global-skills",
    required: false,
    environmentName: "CHROME_POWER_CODEBUDDY_SKILL_DIR",
    installSegments: [".codebuddy", "skills", skillName],
    consumers: [
      {
        id: "codebuddy",
        detectionSegments: [[".codebuddy"]],
      },
      {
        id: "codebuddy-cn",
        detectionSegments: [[".codebuddycn"]],
      },
    ],
  },
  {
    id: "claude",
    manager: "claude-sync",
    required: false,
    installSegments: [".claude", "skills", skillName],
    consumers: [
      {
        id: "claude-code",
        detectionSegments: [[".claude"]],
      },
    ],
  },
  {
    id: "zcode",
    manager: "zcode-sync",
    required: false,
    installSegments: [".zcode", "skills", skillName],
    consumers: [
      {
        id: "zcode",
        detectionSegments: [[".zcode"]],
      },
    ],
  },
])

export function syncGlobalSkills(options = {}) {
  const environment = options.env ?? process.env
  const sourceDir = resolve(
    options.sourceDir ??
      environment.CHROME_POWER_SKILL_SOURCE ??
      join(repoRoot, "skills", skillName)
  )
  const homeDir = resolve(
    options.homeDir ??
      environment.CHROME_POWER_GLOBAL_SKILL_HOME ??
      environment.HOME ??
      homedir()
  )
  const forceAll =
    options.forceAll ??
    (process.argv.includes("--all") ||
      environment.CHROME_POWER_SYNC_ALL_SKILLS === "1")
  const source = inspectSkillDirectory(sourceDir)
  const selected = selectGlobalTargets({
    environment,
    forceAll,
    homeDir,
    registry: options.registry ?? globalSkillTargets,
    targetDirs: options.targetDirs,
  })
  const targets = []

  for (const skippedTarget of selected.skipped) targets.push(skippedTarget)

  for (const operation of selected.operations) {
    const synchronized = syncSkillDirectory({
      sourceDir,
      sourceDigest: source.digest,
      targetDir: operation.path,
      testHooks: options.testHooks?.[operation.id],
    })
    targets.push({
      id: operation.id,
      logicalTargetIds: operation.logicalTargetIds,
      path: operation.path,
      consumers: operation.consumers,
      detectedConsumers: operation.detectedConsumers,
      status: synchronized.status,
      digest: synchronized.digest,
    })
  }

  const warnings = []
  const agentTarget = targets.find(
    (target) =>
      target.logicalTargetIds?.includes("agent-skills") &&
      target.status !== "skipped"
  )
  const legacy = []
  if (agentTarget) {
    const codexLegacy = migrateLegacyCodexSkill({
      environment,
      homeDir,
      legacyDir: options.legacyCodexDir,
      protectedPath: agentTarget.path,
    })
    legacy.push(codexLegacy)
    if (codexLegacy.warning) warnings.push(codexLegacy.warning)
  }

  const geminiLegacy = inspectUnmanagedLegacySkill({
    id: "gemini-user-skill",
    path: resolve(
      options.geminiLegacyDir ??
        join(homeDir, ".gemini", "skills", skillName)
    ),
  })
  legacy.push(geminiLegacy)
  if (geminiLegacy.warning) warnings.push(geminiLegacy.warning)

  return {
    source,
    homeDir,
    forceAll,
    targets,
    legacy,
    warnings,
  }
}

export function syncSkillDirectory(options) {
  const sourceDir = resolve(options.sourceDir)
  const targetDir = resolve(options.targetDir)
  const sourceDigest =
    options.sourceDigest ?? inspectSkillDirectory(sourceDir).digest
  const stagedPath = siblingTemporaryPath(targetDir, "staging")
  const backupPath = siblingTemporaryPath(targetDir, "backup")

  rmSync(stagedPath, { recursive: true, force: true })
  rmSync(backupPath, { recursive: true, force: true })
  mkdirSync(dirname(stagedPath), { recursive: true })
  cpSync(sourceDir, stagedPath, { recursive: true })

  try {
    const stagedDigest = directoryDigest(stagedPath)
    if (stagedDigest !== sourceDigest) {
      throw new Error(
        `Staged Skill digest mismatch at ${stagedPath}: expected ${sourceDigest}, received ${stagedDigest}`
      )
    }

    if (existsSync(targetDir)) {
      const currentDigest = directoryDigest(targetDir)
      if (currentDigest === sourceDigest) {
        return { status: "unchanged", path: targetDir, digest: sourceDigest }
      }
    }

    const hadTarget = existsSync(targetDir)
    if (hadTarget) renameSync(targetDir, backupPath)
    let completed = false
    try {
      renameSync(stagedPath, targetDir)
      options.testHooks?.afterSwap?.(targetDir)
      const finalDigest = directoryDigest(targetDir)
      if (finalDigest !== sourceDigest) {
        throw new Error(
          `Installed Skill digest mismatch at ${targetDir}: expected ${sourceDigest}, received ${finalDigest}`
        )
      }
      completed = true
    } catch (error) {
      rmSync(targetDir, { recursive: true, force: true })
      if (hadTarget && existsSync(backupPath)) {
        try {
          renameSync(backupPath, targetDir)
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Skill update failed and the previous directory could not be restored. Backup preserved at ${backupPath}.`
          )
        }
      }
      throw error
    } finally {
      rmSync(stagedPath, { recursive: true, force: true })
    }

    if (completed) cleanupBackup(backupPath)
    return { status: "updated", path: targetDir, digest: sourceDigest }
  } finally {
    rmSync(stagedPath, { recursive: true, force: true })
  }
}

export function resolveRegisteredSkillTarget(
  targetId,
  homeDir,
  registry = globalSkillTargets
) {
  const target = registry.find((candidate) => candidate.id === targetId)
  if (!target) throw new Error(`Unknown Skill target: ${targetId}`)
  return resolve(homeDir, ...target.installSegments)
}

export function directoryDigest(directoryPath) {
  const rootPath = resolve(directoryPath)
  assertDirectory(rootPath, "Skill directory")
  const entries = collectDirectoryEntries(rootPath)
  const hash = createHash("sha256")
  for (const entry of entries) {
    const pathBuffer = Buffer.from(entry.relativePath, "utf8")
    hash.update(entry.type === "directory" ? "D" : "F")
    hash.update(uint64Buffer(pathBuffer.length))
    hash.update(pathBuffer)
    if (entry.type === "file") {
      const content = readFileSync(entry.absolutePath)
      hash.update(uint64Buffer(content.length))
      hash.update(content)
    }
  }
  return hash.digest("hex")
}

function inspectSkillDirectory(sourceDir) {
  assertDirectory(sourceDir, "Skill source")
  const entryPath = join(sourceDir, "SKILL.md")
  if (!existsSync(entryPath) || !lstatSync(entryPath).isFile()) {
    throw new Error(`Skill source must contain a regular SKILL.md at ${entryPath}`)
  }
  return {
    path: sourceDir,
    digest: directoryDigest(sourceDir),
  }
}

function selectGlobalTargets({
  environment,
  forceAll,
  homeDir,
  registry,
  targetDirs = {},
}) {
  const operationsByPath = new Map()
  const skipped = []

  for (const target of registry) {
    if (target.manager !== "global-skills") continue
    const detectedConsumers = target.consumers
      .filter((consumer) => isConsumerDetected(consumer, homeDir))
      .map((consumer) => consumer.id)
    const consumers = target.consumers.map((consumer) => consumer.id)
    const enabled = target.required || forceAll || detectedConsumers.length > 0
    const targetPath = resolveTargetPath({
      environment,
      homeDir,
      target,
      targetDirs,
    })

    if (!enabled) {
      skipped.push({
        id: target.id,
        logicalTargetIds: [target.id],
        path: targetPath,
        consumers,
        detectedConsumers,
        status: "skipped",
        digest: null,
      })
      continue
    }

    const existing = operationsByPath.get(targetPath)
    if (existing) {
      existing.logicalTargetIds.push(target.id)
      existing.consumers = unique([...existing.consumers, ...consumers])
      existing.detectedConsumers = unique([
        ...existing.detectedConsumers,
        ...detectedConsumers,
      ])
      continue
    }
    operationsByPath.set(targetPath, {
      id: target.id,
      logicalTargetIds: [target.id],
      path: targetPath,
      consumers,
      detectedConsumers,
    })
  }

  return { operations: [...operationsByPath.values()], skipped }
}

function resolveTargetPath({ environment, homeDir, target, targetDirs }) {
  const explicit = targetDirs[target.id]
  if (explicit) return resolve(explicit)
  if (target.environmentName && environment[target.environmentName]) {
    return resolve(environment[target.environmentName])
  }
  return resolveRegisteredSkillTarget(target.id, homeDir)
}

function isConsumerDetected(consumer, homeDir) {
  if (consumer.required) return true
  return consumer.detectionSegments.some((segments) =>
    existsSync(resolve(homeDir, ...segments))
  )
}

function migrateLegacyCodexSkill({
  environment,
  homeDir,
  legacyDir,
  protectedPath,
}) {
  const targetPath = resolve(
    legacyDir ??
      environment.CHROME_POWER_LEGACY_CODEX_SKILL_DIR ??
      join(homeDir, ".codex", "skills", skillName)
  )
  if (protectedPath && targetPath === resolve(protectedPath)) {
    return {
      id: "codex-standalone",
      path: targetPath,
      status: "shared_target",
    }
  }
  if (!existsSync(targetPath)) {
    return { id: "codex-standalone", path: targetPath, status: "absent" }
  }
  if (!isManagedLegacyCodexSkill(targetPath)) {
    return {
      id: "codex-standalone",
      path: targetPath,
      status: "manual_cleanup_required",
      warning: `Preserved unrecognized legacy Codex Skill at ${targetPath}; remove it manually after reviewing its contents to eliminate duplicate discovery.`,
    }
  }

  const retiredPath = siblingTemporaryPath(targetPath, "retired")
  rmSync(retiredPath, { recursive: true, force: true })
  try {
    renameSync(targetPath, retiredPath)
  } catch (error) {
    return {
      id: "codex-standalone",
      path: targetPath,
      status: "manual_cleanup_required",
      warning: `Could not retire the managed legacy Codex Skill at ${targetPath}: ${errorMessage(error)}`,
    }
  }
  try {
    rmSync(retiredPath, { recursive: true, force: true })
  } catch (error) {
    return {
      id: "codex-standalone",
      path: targetPath,
      status: "removed",
      warning: `Legacy Codex Skill was retired, but backup cleanup failed at ${retiredPath}: ${errorMessage(error)}`,
    }
  }
  return { id: "codex-standalone", path: targetPath, status: "removed" }
}

function isManagedLegacyCodexSkill(targetPath) {
  try {
    assertDirectory(targetPath, "Legacy Codex Skill")
    const entries = collectDirectoryEntries(targetPath)
      .map((entry) => `${entry.type}:${entry.relativePath}`)
      .sort()
    const expected = [
      "file:SKILL.md",
      "directory:agents",
      "file:agents/openai.yaml",
    ].sort()
    if (entries.length !== expected.length) return false
    if (!expected.every((entry, index) => entry === entries[index])) {
      return false
    }
    const metadata = readFileSync(
      join(targetPath, "agents", "openai.yaml"),
      "utf8"
    )
    return (
      metadata.includes('display_name: "Chrome Power Browser"') &&
      metadata.includes('value: "chrome-power"') &&
      metadata.includes("Chrome Power MCP browser server")
    )
  } catch {
    return false
  }
}

function inspectUnmanagedLegacySkill({ id, path }) {
  if (!existsSync(path)) return { id, path, status: "absent" }
  return {
    id,
    path,
    status: "manual_cleanup_required",
    warning: `Potential duplicate Skill exists at ${path}; this deployment does not own that directory and left it unchanged.`,
  }
}

function collectDirectoryEntries(rootPath) {
  const entries = []
  visitDirectory(rootPath, rootPath, entries)
  return entries.sort((left, right) => {
    if (left.relativePath < right.relativePath) return -1
    if (left.relativePath > right.relativePath) return 1
    return 0
  })
}

function visitDirectory(rootPath, currentPath, entries) {
  for (const dirent of readdirSync(currentPath, { withFileTypes: true })) {
    const absolutePath = join(currentPath, dirent.name)
    const relativePath = toPosixPath(relative(rootPath, absolutePath))
    if (dirent.isDirectory()) {
      entries.push({ type: "directory", absolutePath, relativePath })
      visitDirectory(rootPath, absolutePath, entries)
      continue
    }
    if (dirent.isFile()) {
      entries.push({ type: "file", absolutePath, relativePath })
      continue
    }
    throw new Error(
      `Skill directory contains unsupported entry at ${absolutePath}`
    )
  }
}

function assertDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist at ${path}`)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory at ${path}`)
  }
}

function siblingTemporaryPath(path, kind) {
  return join(
    dirname(path),
    `.${basename(path)}.${kind}-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  )
}

function cleanupBackup(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    console.warn(
      `Skill synchronization succeeded but backup cleanup failed at ${path}: ${errorMessage(error)}`
    )
  }
}

function uint64Buffer(value) {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeBigUInt64BE(BigInt(value))
  return buffer
}

function toPosixPath(path) {
  return sep === "/" ? path : path.split(sep).join("/")
}

function unique(values) {
  return [...new Set(values)]
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function renderResult(result) {
  console.log(
    `Skill source ${result.source.digest.slice(0, 12)}: ${result.source.path}`
  )
  for (const target of result.targets) {
    const consumers = target.detectedConsumers.length
      ? target.detectedConsumers.join(", ")
      : target.status === "skipped"
        ? "no consumers detected"
        : target.consumers.join(", ")
    console.log(
      `${target.status.padEnd(9)} ${target.path} (${consumers})`
    )
  }
  for (const legacy of result.legacy) {
    console.log(`${legacy.status.padEnd(23)} ${legacy.path}`)
  }
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`)
}

if (isMainModule()) {
  try {
    const result = syncGlobalSkills()
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2))
    } else if (!process.argv.includes("--quiet")) {
      renderResult(result)
    }
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
