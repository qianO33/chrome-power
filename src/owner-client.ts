import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import type { BrowserRuntime } from "./browser-runtime.js"
import type { RuntimeConfig } from "./config.js"
import type { BrowserErrorCode, ToolResult } from "./contracts.js"
import {
  browserToolForRuntimeMethod,
  type BrowserToolCallContext,
  type BrowserToolName,
} from "./tools.js"
import {
  createOwnerReleaseRequest,
  createOwnerRequest,
  encodeJsonLine,
  ownerControlPath,
  ownerEndpoint,
  ownerEndpointLabel,
  parseOwnerResponse,
  type OwnerEndpoint,
  type OwnerResponse,
} from "./owner-ipc.js"

const DEFAULT_OWNER_REQUEST_TIMEOUT_MS = 300_000
const OWNER_CALL_ATTEMPTS = 3
const OWNER_RESTART_TIMEOUT_MS = 5_000

export type BrowserOwnerClientOptions = {
  endpoint?: OwnerEndpoint
  requestTimeoutMs?: number
  startOwner?: (endpoint: OwnerEndpoint) => Promise<void>
  getControlToken?: () => Promise<string>
}

export class BrowserOwnerClient {
  readonly sessionId = randomUUID()
  private readonly endpoint: OwnerEndpoint
  private readonly controlPath: string
  private readonly targetConfigFingerprint?: string
  private readonly requestTimeoutMs: number
  // Deployment replaces this directory. Rebind child processes to the saved
  // path instead of inheriting the retired directory inode from this client.
  private readonly ownerWorkingDirectory = process.cwd()
  private ownerStartPromise: Promise<void> | undefined

  constructor(
    config: RuntimeConfig,
    private readonly options: BrowserOwnerClientOptions = {}
  ) {
    this.endpoint = options.endpoint ?? ownerEndpoint(config)
    this.controlPath = ownerControlPath(config)
    this.targetConfigFingerprint = config.targetConfigFingerprint
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_OWNER_REQUEST_TIMEOUT_MS
  }

  async call(
    tool: BrowserToolName,
    input: unknown = {},
    signal?: AbortSignal
  ): Promise<ToolResult> {
    let lastError: unknown
    for (let attempt = 0; attempt < OWNER_CALL_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        lastError = new OwnerRequestCancelledError(false)
        break
      }
      try {
        const token = await this.getControlToken()
        if (signal?.aborted) {
          lastError = new OwnerRequestCancelledError(false)
          break
        }
        const request = createOwnerRequest(this.sessionId, token, tool, input)
        const response = await sendRequest(
          this.endpoint,
          request,
          this.requestTimeoutMs,
          signal
        )
        if (response.result) return response.result
        if (response.control?.status === "authentication_failed") {
          lastError = new Error("Owner authentication failed before dispatch.")
          if (attempt >= OWNER_CALL_ATTEMPTS - 1) break
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        if (response.control?.status === "shutting_down") {
          if (attempt >= OWNER_CALL_ATTEMPTS - 1) {
            lastError = new Error("Owner remained in shutting-down state.")
            break
          }
          await waitForOwnerToStop(this.endpoint)
          await this.ensureOwnerStarted()
          continue
        }
        return ownerFailure(
          this.sessionId,
          response.error?.message ?? "Owner request failed."
        )
      } catch (error) {
        lastError = error
        if (isOwnerRequestCancelled(error)) break
        if (
          !isSafeToRetryOwnerRequest(error) ||
          attempt >= OWNER_CALL_ATTEMPTS - 1
        ) {
          break
        }
        if (signal?.aborted) {
          lastError = new OwnerRequestCancelledError(false)
          break
        }
        try {
          await this.ensureOwnerStarted()
        } catch (startError) {
          lastError = startError
        }
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    }

    return ownerFailure(
      this.sessionId,
      errorMessage(lastError),
      isOwnerRequestCancelled(lastError)
        ? "operation_cancelled"
        : isOwnerConfigurationError(lastError)
        ? "operation_failed"
        : "browser_unavailable"
    )
  }

  async dispose() {
    await this.getControlToken()
      .then((token) =>
        sendRequest(
          this.endpoint,
          createOwnerReleaseRequest(this.sessionId, token),
          2_000
        )
      )
      .catch(() => undefined)
  }

  private ensureOwnerStarted() {
    this.ownerStartPromise ??= this.startOwner().finally(() => {
      this.ownerStartPromise = undefined
    })
    return this.ownerStartPromise
  }

  private async startOwner() {
    if (this.options.startOwner) {
      await this.options.startOwner(this.endpoint)
      return
    }
    const ownerEntry = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "owner.js"
    )
    const child = spawn(process.execPath, [ownerEntry], {
      cwd: this.ownerWorkingDirectory,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CHROME_POWER_OWNER_PROCESS: "1",
      },
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    child.unref()
    await waitForOwner(this.endpoint)
    await waitForOwnerControl(() => this.getControlToken())
  }

  private async getControlToken() {
    try {
      if (this.options.getControlToken) {
        const token = await this.options.getControlToken()
        if (!token) {
          throw new Error("Owner control metadata has no valid token.")
        }
        return token
      }

      const metadata = JSON.parse(await readFile(this.controlPath, "utf8"))
      const token = controlTokenFromMetadata(
        metadata,
        this.endpoint,
        this.targetConfigFingerprint
      )
      if (!token) {
        // An explicitly configured owner socket can be shared by two clients
        // even when their derived socket identities would otherwise differ.
        // If that socket is live and its metadata does not match this client,
        // fail before sending any request. A dead endpoint is treated as stale
        // metadata so the normal owner-start recovery can replace it.
        if (
          !ownerMetadataIdentityMatches(
            metadata,
            this.endpoint,
            this.targetConfigFingerprint
          ) &&
          (await ownerEndpointIsLive(this.endpoint))
        ) {
          throw new OwnerConfigurationError()
        }
        throw new Error("Owner control metadata has no valid token.")
      }
      return token
    } catch (error) {
      if (error instanceof OwnerConfigurationError) throw error
      throw new OwnerRequestError(
        `Unable to read chrome-power owner control token: ${errorMessage(error)}`,
        true
      )
    }
  }
}

export function createOwnerRuntimeProxy(client: BrowserOwnerClient) {
  return new Proxy(
    {
      sessionId: client.sessionId,
      dispose: () => client.dispose(),
    },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target]
        }
        if (typeof property !== "string") return undefined
        const tool = browserToolForRuntimeMethod(property)
        if (!tool) return undefined
        return (
          input: unknown = {},
          context: BrowserToolCallContext = {}
        ) => client.call(tool, input, context.signal)
      },
    }
  ) as unknown as BrowserRuntime
}

async function waitForOwner(endpoint: OwnerEndpoint) {
  const deadline = Date.now() + OWNER_RESTART_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await sendProbe(endpoint)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(
    `Timed out waiting for chrome-power owner startup: ${ownerEndpointLabel(endpoint)}`
  )
}

export async function ownerEndpointIsLive(
  endpoint: OwnerEndpoint,
  timeoutMs = 250
) {
  try {
    await sendProbe(endpoint, timeoutMs)
    return true
  } catch {
    return false
  }
}

async function waitForOwnerToStop(endpoint: OwnerEndpoint) {
  const deadline = Date.now() + OWNER_RESTART_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await sendProbe(endpoint)
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      return
    }
  }
  throw new Error(
    `Timed out waiting for chrome-power owner shutdown: ${ownerEndpointLabel(endpoint)}`
  )
}

async function waitForOwnerControl(readToken: () => Promise<string>) {
  const deadline = Date.now() + OWNER_RESTART_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await readToken()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(
    `Timed out waiting for chrome-power owner control metadata: ${errorMessage(lastError)}`
  )
}

function sendProbe(endpoint: OwnerEndpoint, timeoutMs = 1_000) {
  return new Promise<void>((resolve, reject) => {
    const socket = connect(endpoint)
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => {
      socket.end()
      resolve()
    })
    socket.once("timeout", () => {
      socket.destroy()
      reject(new Error("Owner probe timed out."))
    })
    socket.once("error", reject)
  })
}

function sendRequest(
  endpoint: OwnerEndpoint,
  request:
    | ReturnType<typeof createOwnerRequest>
    | ReturnType<typeof createOwnerReleaseRequest>,
  timeoutMs = DEFAULT_OWNER_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
) {
  if (signal?.aborted) {
    return Promise.reject(new OwnerRequestCancelledError(false))
  }
  return new Promise<OwnerResponse>((resolve, reject) => {
    let socket: ReturnType<typeof connect>
    try {
      socket = connect(endpoint)
    } catch (error) {
      reject(
        new OwnerRequestError(
          `Unable to connect to chrome-power owner: ${errorMessage(error)}`,
          true
        )
      )
      return
    }
    let buffer = ""
    let settled = false
    let requestMayHaveBeenSent = false

    const cleanup = () => {
      signal?.removeEventListener("abort", abortRequest)
    }
    const rejectWith = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const rejectRequest = (message: string) => {
      rejectWith(new OwnerRequestError(message, !requestMayHaveBeenSent))
    }
    const abortRequest = () => {
      rejectWith(new OwnerRequestCancelledError(requestMayHaveBeenSent))
      socket.destroy()
    }

    signal?.addEventListener("abort", abortRequest, { once: true })
    if (signal?.aborted) {
      abortRequest()
      return
    }
    socket.setEncoding("utf8")
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => {
      if (settled) return
      try {
        socket.write(encodeJsonLine(request))
        requestMayHaveBeenSent = true
      } catch (error) {
        rejectRequest(
          `Unable to write chrome-power owner request: ${errorMessage(error)}`
        )
        socket.destroy()
      }
    })
    socket.on("data", (chunk) => {
      if (settled) return
      buffer += chunk
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) return
      const line = buffer.slice(0, newlineIndex)
      try {
        const response = parseOwnerResponse(JSON.parse(line), request.id)
        if (!response) {
          throw new Error("Response shape or request id was invalid.")
        }
        settled = true
        cleanup()
        socket.end()
        resolve(response)
      } catch (error) {
        socket.destroy()
        rejectWith(
          new OwnerRequestError(
            `Invalid chrome-power owner response: ${errorMessage(error)}`,
            false
          )
        )
      }
    })
    socket.once("timeout", () => {
      socket.destroy()
      rejectRequest("Timed out waiting for chrome-power owner.")
    })
    socket.once("error", (error) => {
      rejectRequest(
        `Chrome-power owner connection failed: ${errorMessage(error)}`
      )
    })
    socket.once("close", () => {
      rejectRequest(
        `Owner connection closed before a response: ${ownerEndpointLabel(endpoint)}`
      )
    })
  })
}

class OwnerRequestError extends Error {
  readonly safeToRetry: boolean

  constructor(message: string, safeToRetry: boolean) {
    super(
      safeToRetry
        ? message
        : `${message} The browser action may have been executed; the request was not retried to avoid duplicate actions.`
    )
    this.name = "OwnerRequestError"
    this.safeToRetry = safeToRetry
  }
}

/**
 * Raised before an owner request is sent when a live owner advertises a
 * different target configuration on the same explicitly supplied endpoint.
 * This is a configuration conflict, not an uncertain browser action, so it
 * must never enter the owner restart/retry loop.
 */
class OwnerConfigurationError extends Error {
  constructor() {
    super(
      "A different chrome-power target configuration is already using this owner. Use a distinct owner socket or the matching target configuration."
    )
    this.name = "OwnerConfigurationError"
  }
}

class OwnerRequestCancelledError extends Error {
  constructor(requestMayHaveBeenSent: boolean) {
    super(
      requestMayHaveBeenSent
        ? "Browser call was cancelled after it may have reached the owner. The browser action may have already started and was not retried."
        : "Browser call was cancelled before it was sent to the owner."
    )
    this.name = "OwnerRequestCancelledError"
  }
}

function isSafeToRetryOwnerRequest(error: unknown) {
  return error instanceof OwnerRequestError && error.safeToRetry
}

function isOwnerRequestCancelled(error: unknown) {
  return error instanceof OwnerRequestCancelledError
}

function isOwnerConfigurationError(error: unknown) {
  return error instanceof OwnerConfigurationError
}

function controlTokenFromMetadata(
  value: unknown,
  expectedEndpoint: OwnerEndpoint,
  expectedTargetConfigFingerprint?: string
) {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token) {
    return undefined
  }
  if (!ownerEndpointsEqual(value.endpoint, expectedEndpoint)) return undefined
  if (!ownerTargetConfigMatches(value, expectedTargetConfigFingerprint)) {
    return undefined
  }
  return value.token
}

function ownerMetadataIdentityMatches(
  value: unknown,
  expectedEndpoint: OwnerEndpoint,
  expectedTargetConfigFingerprint?: string
) {
  return (
    isRecord(value) &&
    ownerEndpointsEqual(value.endpoint, expectedEndpoint) &&
    ownerTargetConfigMatches(value, expectedTargetConfigFingerprint)
  )
}

function ownerTargetConfigMatches(
  value: Record<string, unknown>,
  expectedTargetConfigFingerprint?: string
) {
  if (expectedTargetConfigFingerprint !== undefined) {
    return value.targetConfigFingerprint === expectedTargetConfigFingerprint
  }
  // Older owner metadata omitted this optional field. Treat an omitted field
  // as the legacy configuration, but reject an explicit target fingerprint so
  // a legacy client cannot silently share a multi-target owner.
  return (
    !Object.prototype.hasOwnProperty.call(value, "targetConfigFingerprint") ||
    value.targetConfigFingerprint === undefined
  )
}

function ownerEndpointsEqual(value: unknown, expected: OwnerEndpoint) {
  if (!isRecord(value) || value.kind !== expected.kind) return false
  return expected.kind === "socket"
    ? value.path === expected.path
    : value.host === expected.host && value.port === expected.port
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function connect(endpoint: OwnerEndpoint) {
  return endpoint.kind === "socket"
    ? createConnection(endpoint.path)
    : createConnection(endpoint.port, endpoint.host)
}

function ownerFailure(
  sessionId: string,
  message: string,
  code: BrowserErrorCode = "browser_unavailable"
): ToolResult {
  return {
    ok: false,
    sessionId,
    error: {
      code,
      message,
    },
  }
}

function errorMessage(error: unknown) {
  if (error == null) return "Owner request failed."
  return error instanceof Error ? error.message : String(error)
}
