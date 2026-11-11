import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export const RUNTIME_NAMESPACE_ENV = "CHROME_POWER_NAMESPACE"
export const RUNTIME_NAMESPACE_MAX_LENGTH = 63
export const RUNTIME_NAMESPACE_RESERVED = ["default"] as const

const RUNTIME_NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function parseRuntimeNamespace(value: string | undefined) {
  if (value == null || value.trim() === "") return undefined
  if (value.length > RUNTIME_NAMESPACE_MAX_LENGTH) {
    throw namespaceError(`must be at most ${RUNTIME_NAMESPACE_MAX_LENGTH} characters`)
  }
  if (!RUNTIME_NAMESPACE_PATTERN.test(value)) {
    throw namespaceError(
      "must be a lowercase ASCII slug containing letters, digits, and single internal hyphens"
    )
  }
  if ((RUNTIME_NAMESPACE_RESERVED as readonly string[]).includes(value)) {
    throw namespaceError(`reserved name is not allowed: ${value}`)
  }
  return value
}

export function namespaceProfileDir(baseProfileDir: string, namespace: string) {
  return join(namespaceRootForProfile(baseProfileDir), namespace, "profile")
}

export function namespaceRootForProfile(baseProfileDir: string) {
  return join(dirname(baseProfileDir), "namespaces")
}

export function namespaceArtifactDir(baseDir: string, namespace: string) {
  return join(baseDir, "namespaces", namespace)
}

export function namespaceOwnerSocketPath(profileDir: string) {
  const localPath = join(dirname(profileDir), "owner.sock")
  return safeOwnerSocketPath(localPath, profileDir)
}

export function safeOwnerSocketPath(localPath: string, profileDir: string) {
  if (Buffer.byteLength(localPath) <= 100) return localPath
  const profileKey = createHash("sha256")
    .update(profileDir)
    .digest("hex")
    .slice(0, 12)
  return join(tmpdir(), `chrome-power-owner-${profileKey}.sock`)
}

export function namespaceOwnerControlPath(profileDir: string) {
  return join(dirname(profileDir), "owner.control.json")
}

function namespaceError(message: string) {
  return new Error(`Invalid ${RUNTIME_NAMESPACE_ENV}: ${message}.`)
}
