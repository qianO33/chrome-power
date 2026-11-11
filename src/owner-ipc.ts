import { createHash, randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"

import type { RuntimeConfig } from "./config.js"
import type { ToolResult } from "./contracts.js"
import {
  namespaceOwnerControlPath,
  namespaceOwnerSocketPath,
  safeOwnerSocketPath,
} from "./runtime-namespace.js"
import type { BrowserToolName } from "./tools.js"

export type OwnerCallRequest = {
  id: string
  kind: "call"
  sessionId: string
  token: string
  tool: BrowserToolName
  input?: unknown
}

export type OwnerReleaseRequest = {
  id: string
  kind: "release"
  sessionId: string
  token: string
}

export type OwnerShutdownRequest = {
  id: string
  kind: "shutdown"
  sessionId: string
  token: string
}

export type OwnerRequest =
  | OwnerCallRequest
  | OwnerReleaseRequest
  | OwnerShutdownRequest

export type OwnerControlResult = {
  status:
    | "busy"
    | "accepted"
    | "shutting_down"
    | "authentication_failed"
  activeRequestCount: number
}

export type OwnerResponse = {
  id: string
  result?: ToolResult
  control?: OwnerControlResult
  error?: {
    message: string
  }
}

export function parseOwnerResponse(
  value: unknown,
  expectedId?: string
): OwnerResponse | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined
  if (expectedId != null && value.id !== expectedId) return undefined

  const payloads = ["result", "control", "error"].filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  )
  if (payloads.length !== 1) return undefined

  if (payloads[0] === "result" && isToolResult(value.result)) {
    return { id: value.id, result: value.result }
  }
  if (payloads[0] === "control" && isOwnerControlResult(value.control)) {
    return { id: value.id, control: value.control }
  }
  if (payloads[0] === "error" && isRecord(value.error)) {
    if (typeof value.error.message !== "string") return undefined
    return { id: value.id, error: { message: value.error.message } }
  }
  return undefined
}

export type OwnerEndpoint =
  | {
      kind: "socket"
      path: string
    }
  | {
      kind: "tcp"
      host: string
      port: number
    }

export function createOwnerRequest(
  sessionId: string,
  token: string,
  tool: BrowserToolName,
  input: unknown
): OwnerCallRequest {
  return {
    id: randomUUID(),
    kind: "call",
    sessionId,
    token,
    tool,
    input,
  }
}

export function createOwnerReleaseRequest(
  sessionId: string,
  token: string
): OwnerReleaseRequest {
  return {
    id: randomUUID(),
    kind: "release",
    sessionId,
    token,
  }
}

export function ownerSocketPath(config: RuntimeConfig) {
  if (config.ownerSocket) {
    return config.ownerSocket
  }

  const profileKey = ownerProfileKey(
    config.profileDir,
    config.targetConfigFingerprint
  )
  if (config.namespace) {
    if (config.targetConfigFingerprint) {
      const targetKey = ownerProfileKey(
        config.profileDir,
        config.targetConfigFingerprint
      )
      return safeOwnerSocketPath(
        resolve(dirname(config.profileDir), `owner-${targetKey}.sock`),
        `${config.profileDir}\0targets:${config.targetConfigFingerprint}`
      )
    }
    return namespaceOwnerSocketPath(config.profileDir)
  }
  return safeOwnerSocketPath(
    resolve(dirname(config.profileDir), `chrome-power-owner-${profileKey}.sock`),
    config.targetConfigFingerprint
      ? `${config.profileDir}\0targets:${config.targetConfigFingerprint}`
      : config.profileDir
  )
}

export function ownerControlPath(config: RuntimeConfig) {
  if (config.namespace) {
    if (!config.targetConfigFingerprint) {
      return namespaceOwnerControlPath(config.profileDir)
    }
    // Keep target-specific control metadata in the namespace directory even
    // when the corresponding Unix socket must use the macOS-safe tmp fallback.
    // Distinct target manifests still need distinct records, so a hashed
    // filename is used instead of colliding on the legacy owner.control.json.
    const targetKey = ownerProfileKey(
      config.profileDir,
      config.targetConfigFingerprint
    )
    return resolve(
      dirname(config.profileDir),
      `owner-${targetKey}.control.json`
    )
  }
  return `${ownerSocketPath(config)}.control.json`
}

export function ownerEndpoint(config: RuntimeConfig): OwnerEndpoint {
  const port = config.ownerPort
  if (port) {
    const host = config.ownerHost ?? "127.0.0.1"
    if (!isLoopbackOwnerHost(host)) {
      throw new Error(
        "CHROME_POWER_OWNER_HOST must be 127.0.0.1 or ::1."
      )
    }
    return {
      kind: "tcp",
      host,
      port,
    }
  }

  return {
    kind: "socket",
    path: ownerSocketPath(config),
  }
}

export function ownerEndpointLabel(endpoint: OwnerEndpoint) {
  return endpoint.kind === "socket"
    ? endpoint.path
    : `${endpoint.host}:${endpoint.port}`
}

export function encodeJsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`
}

export function parseOwnerRequest(value: unknown): OwnerRequest | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== "string") return undefined
  if (typeof value.sessionId !== "string") return undefined
  if (typeof value.token !== "string" || value.token === "") return undefined
  if (value.kind === "release") {
    return {
      id: value.id,
      kind: "release",
      sessionId: value.sessionId,
      token: value.token,
    }
  }
  if (value.kind === "shutdown") {
    return {
      id: value.id,
      kind: "shutdown",
      sessionId: value.sessionId,
      token: value.token,
    }
  }
  if (value.kind !== undefined && value.kind !== "call") return undefined
  if (typeof value.tool !== "string") return undefined
  return {
    id: value.id,
    kind: "call",
    sessionId: value.sessionId,
    token: value.token,
    tool: value.tool as BrowserToolName,
    input: value.input,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function isToolResult(value: unknown): value is ToolResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false
  if (typeof value.sessionId !== "string") return false
  if (value.ok) {
    return value.error == null
  }
  return isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    value.data == null
}

function isOwnerControlResult(value: unknown): value is OwnerControlResult {
  if (!isRecord(value)) return false
  if (
    value.status !== "busy" &&
    value.status !== "accepted" &&
    value.status !== "shutting_down" &&
    value.status !== "authentication_failed"
  ) {
    return false
  }
  return (
    typeof value.activeRequestCount === "number" &&
    Number.isInteger(value.activeRequestCount) &&
    value.activeRequestCount >= 0
  )
}

function isLoopbackOwnerHost(host: string) {
  return host === "127.0.0.1" || host === "::1"
}

function ownerProfileKey(profileDir: string, targetFingerprint?: string) {
  const identity = targetFingerprint
    ? `${profileDir}\0targets:${targetFingerprint}`
    : profileDir
  return createHash("sha256").update(identity).digest("hex").slice(0, 12)
}
