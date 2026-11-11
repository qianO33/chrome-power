#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  directoryDigest,
  resolveRegisteredSkillTarget,
  skillName,
  syncGlobalSkills,
  syncSkillDirectory,
} from "./sync-global-skills.mjs"

const scriptPath = fileURLToPath(
  new URL("./sync-global-skills.mjs", import.meta.url)
)
const root = mkdtempSync(join(tmpdir(), "chrome-power-skill-sync-test-"))

try {
  const sourceDir = createSkillSource(join(root, "source"))
  testDetectedAliasesAndMigration(root, sourceDir)
  testSkippedAndForcedTargets(root, sourceDir)
  testTargetPathDeduplication(root, sourceDir)
  testUnrecognizedLegacyPreservation(root, sourceDir)
  testAtomicRollback(root, sourceDir)
  testJsonCli(root, sourceDir)
  testDeploymentWiring()
  testRegistryResolution(root)

  console.log(
    JSON.stringify(
      {
        ok: true,
        detectedAliases: true,
        uniqueTargets: true,
        unrelatedSkillsPreserved: true,
        managedLegacyRemoved: true,
        unknownLegacyPreserved: true,
        atomicRollback: true,
        jsonCli: true,
        symlinkedJsonCli: true,
        deploymentWiring: true,
        registryResolution: true,
      },
      null,
      2
    )
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

function testDetectedAliasesAndMigration(root, sourceDir) {
  const homeDir = join(root, "detected-home")
  mkdirSync(join(homeDir, ".gemini"), { recursive: true })
  mkdirSync(join(homeDir, ".qoder-cn"), { recursive: true })
  mkdirSync(join(homeDir, ".codebuddycn"), { recursive: true })

  const sharedTarget = join(
    homeDir,
    ".agents",
    "skills",
    skillName
  )
  const unrelatedSkill = join(
    homeDir,
    ".agents",
    "skills",
    "unrelated-skill",
    "SKILL.md"
  )
  writeText(join(sharedTarget, "SKILL.md"), "stale shared skill\n")
  writeText(unrelatedSkill, "unrelated\n")
  createManagedLegacyCodexSkill(homeDir)

  const result = syncGlobalSkills({
    env: { HOME: homeDir },
    homeDir,
    sourceDir,
  })

  const shared = activeTarget(result, "agent-skills")
  const qoder = activeTarget(result, "qoder")
  const codebuddy = activeTarget(result, "codebuddy")
  assert.equal(shared.status, "updated")
  assert.deepEqual(shared.detectedConsumers, ["codex", "gemini"])
  assert.equal(qoder.status, "updated")
  assert.deepEqual(qoder.detectedConsumers, ["qoder-cn"])
  assert.equal(codebuddy.status, "updated")
  assert.deepEqual(codebuddy.detectedConsumers, ["codebuddy-cn"])

  assert.equal(directoryDigest(shared.path), directoryDigest(sourceDir))
  assert.equal(directoryDigest(qoder.path), directoryDigest(sourceDir))
  assert.equal(directoryDigest(codebuddy.path), directoryDigest(sourceDir))
  assert.equal(readFileSync(unrelatedSkill, "utf8"), "unrelated\n")
  assert.equal(
    existsSync(join(homeDir, ".qoder-cn", "skills", skillName)),
    false
  )
  assert.equal(
    existsSync(join(homeDir, ".codebuddycn", "skills", skillName)),
    false
  )
  assert.equal(
    existsSync(join(homeDir, ".gemini", "skills", skillName)),
    false
  )
  assert.equal(
    existsSync(join(homeDir, ".codex", "skills", skillName)),
    false
  )
  assert.equal(
    result.legacy.find((entry) => entry.id === "codex-standalone")
      ?.status,
    "removed"
  )

  const repeat = syncGlobalSkills({
    env: { HOME: homeDir },
    homeDir,
    sourceDir,
  })
  assert.equal(activeTarget(repeat, "agent-skills").status, "unchanged")
  assert.equal(activeTarget(repeat, "qoder").status, "unchanged")
  assert.equal(activeTarget(repeat, "codebuddy").status, "unchanged")
}

function testSkippedAndForcedTargets(root, sourceDir) {
  const detectedHome = join(root, "minimal-home")
  const detected = syncGlobalSkills({
    env: { HOME: detectedHome },
    homeDir: detectedHome,
    sourceDir,
  })
  assert.equal(activeTarget(detected, "agent-skills").status, "updated")
  assert.equal(targetById(detected, "qoder").status, "skipped")
  assert.equal(targetById(detected, "codebuddy").status, "skipped")
  assert.equal(existsSync(join(detectedHome, ".qoder")), false)
  assert.equal(existsSync(join(detectedHome, ".codebuddy")), false)

  const forcedHome = join(root, "forced-home")
  const forced = syncGlobalSkills({
    env: { HOME: forcedHome },
    forceAll: true,
    homeDir: forcedHome,
    sourceDir,
  })
  assert.equal(activeTarget(forced, "qoder").status, "updated")
  assert.equal(activeTarget(forced, "codebuddy").status, "updated")
}

function testTargetPathDeduplication(root, sourceDir) {
  const homeDir = join(root, "dedupe-home")
  mkdirSync(join(homeDir, ".qoder"), { recursive: true })
  mkdirSync(join(homeDir, ".qoder-cn"), { recursive: true })
  const sharedTarget = join(homeDir, "shared-target", skillName)
  const result = syncGlobalSkills({
    env: { HOME: homeDir },
    homeDir,
    sourceDir,
    targetDirs: {
      "agent-skills": sharedTarget,
      qoder: sharedTarget,
    },
  })
  const synchronized = result.targets.filter(
    (target) => target.status !== "skipped"
  )
  assert.equal(synchronized.length, 1)
  assert.deepEqual(synchronized[0].logicalTargetIds, ["agent-skills", "qoder"])
  assert.deepEqual(synchronized[0].detectedConsumers, [
    "codex",
    "qoder",
    "qoder-cn",
  ])
  assert.equal(directoryDigest(sharedTarget), directoryDigest(sourceDir))
}

function testUnrecognizedLegacyPreservation(root, sourceDir) {
  const homeDir = join(root, "custom-legacy-home")
  const legacyDir = join(homeDir, ".codex", "skills", skillName)
  writeText(join(legacyDir, "SKILL.md"), "custom skill\n")
  writeText(join(legacyDir, "notes.txt"), "keep me\n")
  const geminiLegacy = join(homeDir, ".gemini", "skills", skillName)
  writeText(join(geminiLegacy, "SKILL.md"), "user-owned gemini skill\n")

  const result = syncGlobalSkills({
    env: { HOME: homeDir },
    homeDir,
    sourceDir,
  })
  assert.equal(readFileSync(join(legacyDir, "notes.txt"), "utf8"), "keep me\n")
  assert.equal(
    result.legacy.find((entry) => entry.id === "codex-standalone")
      ?.status,
    "manual_cleanup_required"
  )
  assert.equal(
    result.legacy.find((entry) => entry.id === "gemini-user-skill")
      ?.status,
    "manual_cleanup_required"
  )
  assert.equal(result.warnings.length, 2)
}

function testAtomicRollback(root, sourceDir) {
  const targetDir = join(root, "rollback-home", "skills", skillName)
  writeText(join(targetDir, "SKILL.md"), "previous skill\n")
  writeText(join(targetDir, "keep.txt"), "previous extra\n")
  const previousDigest = directoryDigest(targetDir)

  assert.throws(
    () =>
      syncSkillDirectory({
        sourceDir,
        targetDir,
        testHooks: {
          afterSwap(installedDir) {
            writeText(join(installedDir, "corrupt.txt"), "corrupt\n")
          },
        },
      }),
    /Installed Skill digest mismatch/
  )
  assert.equal(directoryDigest(targetDir), previousDigest)
  assert.equal(readFileSync(join(targetDir, "keep.txt"), "utf8"), "previous extra\n")
  assert.deepEqual(
    readdirSync(dirname(targetDir)).filter((name) => name.startsWith(`.${skillName}`)),
    []
  )
}

function testJsonCli(root, sourceDir) {
  const homeDir = join(root, "cli-home")
  mkdirSync(join(homeDir, ".qoder-cn"), { recursive: true })
  const result = spawnSync(process.execPath, [scriptPath, "--json"], {
    env: {
      ...process.env,
      HOME: homeDir,
      CHROME_POWER_GLOBAL_SKILL_HOME: homeDir,
      CHROME_POWER_SKILL_SOURCE: sourceDir,
    },
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(activeTarget(payload, "agent-skills").status, "updated")
  assert.equal(activeTarget(payload, "qoder").status, "updated")
  assert.equal(targetById(payload, "codebuddy").status, "skipped")

  const linkedScriptDir = join(root, "linked-cli")
  const linkedScriptPath = join(linkedScriptDir, "sync-global-skills.mjs")
  const linkedHomeDir = join(root, "linked-cli-home")
  mkdirSync(linkedScriptDir, { recursive: true })
  symlinkSync(scriptPath, linkedScriptPath)
  const linkedResult = spawnSync(
    process.execPath,
    [linkedScriptPath, "--json"],
    {
      env: {
        ...process.env,
        HOME: linkedHomeDir,
        CHROME_POWER_GLOBAL_SKILL_HOME: linkedHomeDir,
        CHROME_POWER_SKILL_SOURCE: sourceDir,
      },
      encoding: "utf8",
    }
  )
  assert.equal(linkedResult.status, 0, linkedResult.stderr)
  const linkedPayload = JSON.parse(linkedResult.stdout)
  assert.equal(activeTarget(linkedPayload, "agent-skills").status, "updated")
}

function testDeploymentWiring() {
  const deployScript = readFileSync(
    fileURLToPath(new URL("./deploy-codex-global.mjs", import.meta.url)),
    "utf8"
  )
  assert.match(deployScript, /scripts", "sync-global-skills\.mjs"/)
  assert.match(deployScript, /CHROME_POWER_GLOBAL_SKILL_HOME/)
  assert.match(
    deployScript,
    /join\(\s*globalSkillHome,\s*"\.codex",\s*"skills"/s
  )
  assert.doesNotMatch(deployScript, /function writeStandaloneSkill/)
}

function testRegistryResolution(root) {
  const homeDir = join(root, "registry-home")
  assert.equal(
    resolveRegisteredSkillTarget("claude", homeDir),
    join(homeDir, ".claude", "skills", skillName)
  )
  assert.throws(
    () => resolveRegisteredSkillTarget("missing", homeDir),
    /Unknown Skill target/
  )
}

function createSkillSource(sourceDir) {
  writeText(
    join(sourceDir, "SKILL.md"),
    "---\nname: chrome-power-browser\ndescription: fixture\n---\n\nFixture skill.\n"
  )
  writeText(join(sourceDir, "references", "usage.md"), "fixture reference\n")
  return sourceDir
}

function createManagedLegacyCodexSkill(homeDir) {
  const legacyDir = join(homeDir, ".codex", "skills", skillName)
  writeText(join(legacyDir, "SKILL.md"), "legacy managed skill\n")
  writeText(
    join(legacyDir, "agents", "openai.yaml"),
    `interface:
  display_name: "Chrome Power Browser"
dependencies:
  tools:
    - type: "mcp"
      value: "chrome-power"
      description: "Chrome Power MCP browser server"
`
  )
}

function targetById(result, id) {
  const target = result.targets.find((entry) => entry.id === id)
  assert.ok(target, `Missing target ${id}`)
  return target
}

function activeTarget(result, logicalTargetId) {
  const target = result.targets.find(
    (entry) =>
      entry.status !== "skipped" &&
      entry.logicalTargetIds.includes(logicalTargetId)
  )
  assert.ok(target, `Missing active target ${logicalTargetId}`)
  return target
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
