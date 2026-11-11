import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { RuntimeMetadata } from "./contracts.js"

let cached: RuntimeMetadata | undefined

export function loadRuntimeMetadata(): RuntimeMetadata {
  cached ??= {
    packageVersion: readPackageVersion(),
    deployedCommit: readDeployedCommit(),
    mode: process.env.CHROME_POWER_OWNER_PROCESS === "1" ? "owner" : "direct",
  }
  return cached
}

function readPackageVersion() {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url))
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown
    }
    return typeof payload.version === "string" && payload.version.trim() !== ""
      ? payload.version
      : "unknown"
  } catch {
    return "unknown"
  }
}

function readDeployedCommit() {
  try {
    const path = fileURLToPath(new URL("../DEPLOYED_COMMIT", import.meta.url))
    const value = readFileSync(path, "utf8").trim()
    return value || undefined
  } catch {
    return undefined
  }
}
