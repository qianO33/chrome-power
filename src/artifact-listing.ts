import { readdir, stat } from "node:fs/promises"
import { extname, resolve } from "node:path"

import type {
  ArtifactEntry,
  ArtifactType,
  ArtifactsData,
} from "./contracts.js"
import { SUPPORTED_ARTIFACT_TYPES } from "./contracts.js"
import { BrowserToolError } from "./errors.js"
import type { RuntimeConfig } from "./config.js"
import { isNotFoundError, isSupportedArtifactType } from "./validation-utils.js"

export type ArtifactsOptions = {
  types?: string[]
  limit?: number
}

const DEFAULT_ARTIFACT_LIMIT = 100
const MAX_ARTIFACT_LIMIT = 1_000

function resolveArtifactTypes(types: string[] | undefined): Set<ArtifactType> {
  if (types == null) return new Set(SUPPORTED_ARTIFACT_TYPES)
  if (types.length === 0) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide at least one artifact type."
    )
  }

  const resolved = new Set<ArtifactType>()
  for (const type of types) {
    if (!isSupportedArtifactType(type)) {
      throw new BrowserToolError(
        "invalid_request",
        `Unsupported artifact type: ${type}`
      )
    }
    resolved.add(type)
  }
  return resolved
}

function resolveArtifactLimit(limit: number | undefined) {
  if (limit == null) return DEFAULT_ARTIFACT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_ARTIFACT_LIMIT) {
    throw new BrowserToolError(
      "invalid_request",
      `Artifact limit must be an integer between 1 and ${MAX_ARTIFACT_LIMIT}.`
    )
  }
  return limit
}

async function listArtifactsForType(
  type: ArtifactType,
  config: { screenshotDir: string; downloadDir: string }
): Promise<ArtifactEntry[]> {
  const root = type === "screenshot" ? config.screenshotDir : config.downloadDir
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isNotFoundError(error)) return []
    throw error
  }

  const artifacts: ArtifactEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (
      type === "screenshot" &&
      extname(entry.name).toLowerCase() !== ".png"
    ) {
      continue
    }
    const path = resolve(root, entry.name)
    let fileStat
    try {
      fileStat = await stat(path)
    } catch (error) {
      if (isNotFoundError(error)) continue
      throw error
    }
    if (!fileStat.isFile()) continue
    artifacts.push({
      type,
      name: entry.name,
      path,
      size: fileStat.size,
      modifiedTime: fileStat.mtime.toISOString(),
    })
  }

  return artifacts
}

export async function listArtifacts(
  config: RuntimeConfig,
  options: ArtifactsOptions
): Promise<ArtifactsData> {
  const types = resolveArtifactTypes(options.types)
  const limit = resolveArtifactLimit(options.limit)
  const artifacts = (
    await Promise.all(
      [...types].map((type) => listArtifactsForType(type, config))
    )
  )
    .flat()
    .sort(
      (a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime)
    )
    .slice(0, limit)

  return {
    roots: {
      screenshots: config.screenshotDir,
      downloads: config.downloadDir,
    },
    artifacts,
  }
}
