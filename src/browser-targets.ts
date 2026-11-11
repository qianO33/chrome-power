import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { dirname, join, resolve } from "node:path"

import type {
  BrowserTargetConnection,
  BrowserTargetDefinition,
} from "./contracts.js"

export const BROWSER_TARGET_CONFIG_VERSION = 1 as const
export const MAX_BROWSER_TARGETS = 32
export const MAX_BROWSER_TARGET_ID_LENGTH = 63
export const MAX_BROWSER_TARGET_LABEL_LENGTH = 200

const TARGET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type BrowserTargetsFile = {
  version: typeof BROWSER_TARGET_CONFIG_VERSION
  defaultTargetId?: string
  targets: BrowserTargetDefinition[]
  filePath?: string
  fingerprint?: string
}

/**
 * Load and validate the opt-in target file. This function deliberately reads
 * only the target manifest; active-port metadata is resolved later, on an
 * explicit connect request.
 */
export function loadBrowserTargetsFile(filePath: string): BrowserTargetsFile {
  const resolvedPath = resolve(filePath)
  let source: string
  try {
    source = readFileSync(resolvedPath, "utf8")
  } catch {
    throw new Error(
      "Invalid CHROME_POWER_TARGETS_FILE: unable to read target configuration."
    )
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(
      "Invalid CHROME_POWER_TARGETS_FILE: configuration must be valid JSON."
    )
  }

  const parsed = parseBrowserTargetsFile(value, dirname(resolvedPath))
  const normalized = JSON.stringify({
    version: parsed.version,
    defaultTarget: parsed.defaultTargetId,
    targets: parsed.targets,
  })
  return {
    ...parsed,
    filePath: resolvedPath,
    fingerprint: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
  }
}

export function parseBrowserTargetsFile(
  value: unknown,
  baseDir = process.cwd()
): BrowserTargetsFile {
  if (!isRecord(value)) {
    throw targetConfigError("configuration must be an object")
  }
  assertKeys(value, new Set(["version", "defaultTarget", "targets"]), "configuration")
  if (value.version !== BROWSER_TARGET_CONFIG_VERSION) {
    throw targetConfigError("version must be 1")
  }
  if (!Array.isArray(value.targets)) {
    throw targetConfigError("targets must be an array")
  }
  if (
    value.targets.length < 1 ||
    value.targets.length > MAX_BROWSER_TARGETS
  ) {
    throw targetConfigError(
      `targets must contain between 1 and ${MAX_BROWSER_TARGETS} entries`
    )
  }

  const targets: BrowserTargetDefinition[] = []
  const ids = new Set<string>()
  for (const rawTarget of value.targets) {
    const target = decodeTarget(rawTarget, baseDir)
    if (ids.has(target.id)) {
      throw targetConfigError(`duplicate target id: ${target.id}`)
    }
    ids.add(target.id)
    targets.push(target)
  }

  let defaultTargetId: string | undefined
  if (Object.hasOwn(value, "defaultTarget")) {
    if (typeof value.defaultTarget !== "string") {
      throw targetConfigError("defaultTarget must be a target id")
    }
    // `power` is the built-in launch target and may be selected as the
    // explicit default, even though configured attach definitions may not
    // reuse that reserved id.
    if (value.defaultTarget !== "power") validateTargetId(value.defaultTarget)
    if (value.defaultTarget !== "power" && !ids.has(value.defaultTarget)) {
      throw targetConfigError("defaultTarget must refer to a configured target")
    }
    defaultTargetId = value.defaultTarget
  }

  return {
    version: BROWSER_TARGET_CONFIG_VERSION,
    defaultTargetId,
    targets,
  }
}

export function validateTargetId(value: string) {
  if (
    value.length === 0 ||
    value.length > MAX_BROWSER_TARGET_ID_LENGTH ||
    !TARGET_ID_PATTERN.test(value) ||
    value === "power" ||
    value === "default"
  ) {
    throw targetConfigError(
      "target ids must be lowercase slugs (power and default are reserved)"
    )
  }
  return value
}

export function resolveBrowserTargetEndpoint(
  target: BrowserTargetDefinition
): string {
  if (target.connection.kind === "endpoint") {
    return target.connection.endpoint
  }

  const activePortFile =
    target.connection.activePortFile ??
    (target.connection.userDataDir
      ? join(target.connection.userDataDir, "DevToolsActivePort")
      : undefined)
  if (!activePortFile) {
    throw new TargetEndpointError(
      "Target active-port metadata is not configured."
    )
  }

  let source: string
  try {
    source = readFileSync(activePortFile, "utf8")
  } catch {
    throw new TargetEndpointError(
      "Target active-port metadata is unavailable."
    )
  }
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length > 2) {
    throw new TargetEndpointError("Target active-port metadata is malformed.")
  }
  const port = Number(lines[0])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TargetEndpointError("Target active-port metadata is malformed.")
  }

  // Chrome's second line is the browser websocket path. Newer Chrome builds
  // (including the M144+ remote-debugging flow exposed from
  // chrome://inspect/#remote-debugging) intentionally do not serve the
  // legacy /json/version HTTP discovery endpoints. Use the exact websocket
  // endpoint from DevToolsActivePort so both the new authorized flow and
  // traditional --remote-debugging-port instances work. The endpoint never
  // leaves this process or appears in a tool result.
  if (lines[1] != null && !lines[1].startsWith("/")) {
    throw new TargetEndpointError("Target active-port metadata is malformed.")
  }
  // Older Chromium builds occasionally wrote only the port. Keep that
  // legacy form usable through HTTP discovery; modern Chrome writes the
  // websocket path and must use it because its discovery routes return 404.
  return lines[1]
    ? `ws://127.0.0.1:${port}${lines[1]}`
    : `http://127.0.0.1:${port}`
}

export function normalizeTargetConnection(
  value: unknown,
  baseDir = process.cwd()
): BrowserTargetConnection {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw targetConfigError("connection must describe an endpoint or active_port")
  }
  assertKeys(
    value,
    new Set(["kind", "endpoint", "userDataDir", "activePortFile"]),
    "connection"
  )
  if (value.kind === "endpoint") {
    assertKeys(value, new Set(["kind", "endpoint"]), "endpoint connection")
    if (typeof value.endpoint !== "string") {
      throw targetConfigError("endpoint connection requires endpoint")
    }
    return {
      kind: "endpoint",
      endpoint: validateLoopbackEndpoint(value.endpoint),
    }
  }
  if (value.kind === "active_port") {
    assertKeys(
      value,
      new Set(["kind", "userDataDir", "activePortFile"]),
      "active_port connection"
    )
    const hasUserDataDir =
      typeof value.userDataDir === "string" && value.userDataDir.trim() !== ""
    const hasActivePortFile =
      typeof value.activePortFile === "string" &&
      value.activePortFile.trim() !== ""
    if (!hasUserDataDir && !hasActivePortFile) {
      throw targetConfigError(
        "active_port connection requires userDataDir or activePortFile"
      )
    }
    if (value.userDataDir != null && !hasUserDataDir) {
      throw targetConfigError("userDataDir must be a path")
    }
    if (value.activePortFile != null && !hasActivePortFile) {
      throw targetConfigError("activePortFile must be a path")
    }
    return {
      kind: "active_port",
      ...(hasUserDataDir
        ? { userDataDir: resolve(baseDir, value.userDataDir as string) }
        : {}),
      ...(hasActivePortFile
        ? { activePortFile: resolve(baseDir, value.activePortFile as string) }
        : {}),
    }
  }
  throw targetConfigError("connection kind must be endpoint or active_port")
}

export class TargetEndpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TargetEndpointError"
  }
}

function decodeTarget(value: unknown, baseDir: string): BrowserTargetDefinition {
  if (!isRecord(value)) throw targetConfigError("target must be an object")
  assertKeys(value, new Set(["id", "label", "browser", "connection"]), "target")
  if (typeof value.id !== "string") {
    throw targetConfigError("target id must be a string")
  }
  validateTargetId(value.id)
  if (
    typeof value.label !== "string" ||
    value.label.trim() === "" ||
    value.label.length > MAX_BROWSER_TARGET_LABEL_LENGTH
  ) {
    throw targetConfigError("target label must be a non-empty bounded string")
  }
  if (value.browser !== "chrome") {
    throw targetConfigError("only browser: chrome is supported")
  }
  return {
    id: value.id,
    label: value.label,
    browser: "chrome",
    connection: normalizeTargetConnection(value.connection, baseDir),
  }
}

function validateLoopbackEndpoint(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw targetConfigError("endpoint must be a loopback CDP URL")
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw targetConfigError("endpoint must use HTTP(S) or WebSocket protocol")
  }
  if (url.username !== "" || url.password !== "") {
    throw targetConfigError("endpoint credentials are not allowed")
  }
  if (!isLoopbackHost(url.hostname)) {
    throw targetConfigError("endpoint must resolve to a loopback host")
  }
  const port = url.port === "" ? undefined : Number(url.port)
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw targetConfigError("endpoint port is invalid")
  }
  return url.toString()
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized === "::1") return true
  if (isIP(normalized) !== 4) return false
  const first = Number(normalized.split(".")[0])
  return first === 127
}

function targetConfigError(detail: string) {
  return new Error(`Invalid CHROME_POWER_TARGETS_FILE: ${detail}.`)
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw targetConfigError(`${label} contains unsupported field: ${key}`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}
