#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import { createConnection, createServer, type Socket } from "node:net"
import { dirname, resolve } from "node:path"

import { BrowserRuntime } from "./browser-runtime.js"
import { BrowserTargetManager } from "./browser-target-manager.js"
import { loadConfig } from "./config.js"
import { BrowserSessionRouter } from "./session-router.js"
import {
  encodeJsonLine,
  ownerControlPath,
  ownerEndpoint,
  parseOwnerRequest,
  type OwnerResponse,
} from "./owner-ipc.js"
import { loadRuntimeMetadata } from "./runtime-metadata.js"
import { isBrowserToolName } from "./tools.js"

const config = loadConfig()
const endpoint = ownerEndpoint(config)
const controlPath = ownerControlPath(config)
const controlToken = randomBytes(32).toString("hex")
const targetManager = new BrowserTargetManager(config)
const runtime = targetManager.powerRuntime
const router = new BrowserSessionRouter(runtime, {
  endpoint,
  targetManager,
  browserCallLimits: config.browserCallLimits,
})
const idleTimeoutMs = parseIdleTimeoutMs()
const OWNER_SOCKET_TIMEOUT_MS = 300_000
const OWNER_MAX_FRAME_BYTES = 10 * 1024 * 1024
let idleTimer: NodeJS.Timeout | undefined
let activeRequests = 0
let shuttingDown = false
let shutdownPromise: Promise<void> | undefined

if (endpoint.kind === "socket") {
  await mkdir(dirname(endpoint.path), { recursive: true })
}

const server = createServer((socket) => {
  let buffer = ""
  const pendingRequests = new Set<AbortController>()
  socket.setEncoding("utf8")
  socket.setTimeout(OWNER_SOCKET_TIMEOUT_MS)
  socket.on("timeout", () => socket.destroy())
  socket.on("error", (error) => {
    logOwnerError("client socket error", error)
    socket.destroy()
  })
  socket.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        if (Buffer.byteLength(buffer) > OWNER_MAX_FRAME_BYTES) {
          socket.destroy()
        }
        return
      }
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line) > OWNER_MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }
      if (line.trim() === "") continue
      if (shuttingDown) {
        writeResponse(socket, shuttingDownResponse(line))
        continue
      }
      activeRequests += 1
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
      const controller = new AbortController()
      pendingRequests.add(controller)
      void handleLine(line, controller.signal)
        .then((response) => {
          pendingRequests.delete(controller)
          writeResponse(socket, response, () => {
            if (response.control?.status === "accepted") {
              setImmediate(() => void shutdown(0))
            }
          })
        })
        .catch((error) => {
          pendingRequests.delete(controller)
          writeResponse(
            socket,
            errorResponse(responseIdFromLine(line), errorMessage(error))
          )
        })
        .finally(() => {
          activeRequests -= 1
          resetIdleTimer()
        })
    }
  })
  socket.once("close", () => {
    for (const controller of pendingRequests) controller.abort()
    pendingRequests.clear()
    resetIdleTimer()
  })
})

process.on("SIGINT", () => {
  void shutdown(130)
})

process.on("SIGTERM", () => {
  void shutdown(143)
})

process.on("uncaughtException", (error) => {
  logOwnerError("uncaught exception", error)
  void shutdown(1)
})

process.on("unhandledRejection", (reason) => {
  logOwnerError("unhandled rejection", reason)
  void shutdown(1)
})

const ownsEndpoint = await listenAsOwner()
if (!ownsEndpoint) process.exit(0)
await writeControlMetadata()
resetIdleTimer()

async function handleLine(
  line: string,
  signal: AbortSignal
): Promise<OwnerResponse> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return errorResponse("invalid-json", errorMessage(error))
  }

  const request = parseOwnerRequest(parsed)
  if (!request) {
    return errorResponse("invalid-request", "Owner request must be an object.")
  }

  if (!validControlToken(request.token)) {
    return authenticationFailedResponse(request.id)
  }

  if (request.kind === "release") {
    router.releaseSession(request.sessionId)
    return {
      id: request.id,
      result: {
        ok: true,
        sessionId: runtime.sessionId,
        data: { released: true },
      },
    }
  }

  if (request.kind === "shutdown") {
    if (activeRequests > 1) {
      return {
        id: request.id,
        control: {
          status: "busy",
          activeRequestCount: activeRequests - 1,
        },
      }
    }
    shuttingDown = true
    return {
      id: request.id,
      control: { status: "accepted", activeRequestCount: 0 },
    }
  }

  if (!isBrowserToolName(request.tool)) {
    return errorResponse(request.id, `Unknown browser tool: ${request.tool}`)
  }

  try {
    return {
      id: request.id,
      result: await router.call(
        request.sessionId,
        request.tool,
        request.input,
        { signal }
      ),
    }
  } catch (error) {
    return errorResponse(request.id, errorMessage(error))
  }
}

async function listenAsOwner() {
  if (await endpointIsLive()) return false
  if (endpoint.kind !== "socket") {
    try {
      await listenOnce()
      return true
    } catch (error) {
      if (!isAddressInUse(error)) throw error
      if (await waitForLiveEndpoint(1_500)) return false
      throw error
    }
  }

  const electionLock = `${endpoint.path}.startup-lock`
  try {
    await mkdir(electionLock)
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (await waitForLiveEndpoint(5_000)) return false
    await rmdir(electionLock).catch(() => undefined)
    return await listenAsOwner()
  }

  try {
    if (await endpointIsLive()) return false
    await unlink(endpoint.path).catch(() => undefined)
    await listenOnce()
    await chmod(endpoint.path, 0o600)
    return true
  } finally {
    await rmdir(electionLock).catch(() => undefined)
  }
}

function listenOnce() {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    if (endpoint.kind === "socket") {
      server.listen(endpoint.path)
    } else {
      server.listen(endpoint.port, endpoint.host)
    }
  })
}

async function waitForLiveEndpoint(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await endpointIsLive()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function endpointIsLive() {
  return new Promise<boolean>((resolve) => {
    const socket =
      endpoint.kind === "socket"
        ? createConnection(endpoint.path)
        : createConnection(endpoint.port, endpoint.host)
    let settled = false
    const finish = (live: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(live)
    }
    socket.setTimeout(250)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

function isAddressInUse(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  )
}

function isAlreadyExists(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  )
}

function errorResponse(id: string, message: string): OwnerResponse {
  return {
    id,
    error: { message },
  }
}

function shuttingDownResponse(line: string): OwnerResponse {
  return {
    id: responseIdFromLine(line),
    control: { status: "shutting_down", activeRequestCount: 0 },
  }
}

function authenticationFailedResponse(id: string): OwnerResponse {
  return {
    id,
    control: { status: "authentication_failed", activeRequestCount: 0 },
  }
}

function responseIdFromLine(line: string) {
  try {
    const value = JSON.parse(line) as { id?: unknown }
    return typeof value.id === "string" ? value.id : "unknown-request"
  } catch {
    return "unknown-request"
  }
}

function writeResponse(
  socket: Socket,
  response: OwnerResponse,
  onFlushed?: () => void
) {
  if (socket.destroyed || !socket.writable) return false
  try {
    socket.write(encodeJsonLine(response), (error) => {
      if (error) {
        logOwnerError("client response write failed", error)
        socket.destroy()
        return
      }
      onFlushed?.()
    })
    return true
  } catch (error) {
    logOwnerError("client response write failed", error)
    socket.destroy()
    return false
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function shutdown(exitCode: number) {
  shutdownPromise ??= performShutdown(exitCode)
  return shutdownPromise
}

async function performShutdown(exitCode: number) {
  shuttingDown = true
  if (idleTimer) clearTimeout(idleTimer)
  router.dispose()
  await targetManager.dispose().catch(() => undefined)
  if (server.listening) server.close()
  if (endpoint.kind === "socket") {
    await unlink(endpoint.path).catch(() => undefined)
  }
  await removeOwnedControlMetadata()
  process.exit(exitCode)
}

function logOwnerError(context: string, error: unknown) {
  console.error(`[chrome-power owner] ${context}: ${errorMessage(error)}`)
}

async function writeControlMetadata() {
  const temporaryPath = `${controlPath}.${process.pid}.tmp`
  const metadata = {
    version: 1,
    pid: process.pid,
    token: controlToken,
    endpoint,
    endpointLabel:
      endpoint.kind === "socket"
        ? endpoint.path
        : `${endpoint.host}:${endpoint.port}`,
    namespace: config.namespace,
    profileDir: config.profileDir,
    targetConfigFingerprint: config.targetConfigFingerprint,
    deployedCommit: loadRuntimeMetadata().deployedCommit,
    ownerEntry: resolve(process.argv[1] ?? ""),
    startedAt: new Date().toISOString(),
  }
  await mkdir(dirname(controlPath), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, controlPath)
}

async function removeOwnedControlMetadata() {
  try {
    const metadata = JSON.parse(await readFile(controlPath, "utf8")) as {
      pid?: unknown
      token?: unknown
    }
    if (metadata.pid !== process.pid || metadata.token !== controlToken) return
    await unlink(controlPath)
  } catch {
    // Missing or replaced metadata belongs to no longer-current owner state.
  }
}

function validControlToken(token: string) {
  const actual = Buffer.from(controlToken)
  const candidate = Buffer.from(token)
  return actual.length === candidate.length && timingSafeEqual(actual, candidate)
}

function resetIdleTimer() {
  if (!idleTimeoutMs) return
  if (activeRequests > 0) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void shutdown(0)
  }, idleTimeoutMs)
  idleTimer.unref()
}

function parseIdleTimeoutMs() {
  const value = process.env.CHROME_POWER_OWNER_IDLE_MS
  if (value == null || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
