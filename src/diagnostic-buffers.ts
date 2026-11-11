import { randomUUID } from "node:crypto"

import type {
  ConsoleMessage,
  Page,
  Request,
  Response,
  WebSocket as PlaywrightWebSocket,
} from "playwright"
import type {
  ConsoleLogEntry,
  NetworkEventEntry,
  PageErrorEntry,
  WebSocketEventEntry,
  WebSocketEventType,
  WebSocketFrameDirection,
} from "./contracts.js"
import { BrowserToolError } from "./errors.js"
import type {
  NetworkQueryOptions,
  WebSocketQueryOptions,
} from "./diagnostics-filter.js"
import {
  filterNetworkEvents,
  filterWebSocketEvents,
  normalizeConsoleLevel,
  webSocketPayloadBytes,
} from "./diagnostics-filter.js"
import {
  boundedDiagnosticUrl,
  sleep,
  trimStart,
  truncate,
} from "./validation-utils.js"

export const DEFAULT_CONSOLE_LOG_LIMIT = 100
export const MAX_CONSOLE_LOGS_PER_TAB = 1_000
export const MAX_CONSOLE_MESSAGE_LENGTH = 4_000
export const DEFAULT_DIAGNOSTIC_EVENT_LIMIT = 100
export const MAX_DIAGNOSTIC_EVENTS_PER_TAB = 1_000
export const MAX_DIAGNOSTIC_TEXT_LENGTH = 4_000
export const DIAGNOSTIC_WAIT_POLL_INTERVAL_MS = 50

type WebSocketFrameData = { payload: string | Buffer }

export type DiagnosticBufferDeps = {
  isTabTracked(tabId: string): boolean
  frameIdForRequest(tabId: string, request: Request): string | undefined
}

export class DiagnosticBuffers {
  readonly consoleLogsByTab = new Map<string, ConsoleLogEntry[]>()
  readonly pageErrorsByTab = new Map<string, PageErrorEntry[]>()
  readonly networkEventsByTab = new Map<string, NetworkEventEntry[]>()
  readonly webSocketEventsByTab = new Map<string, WebSocketEventEntry[]>()
  private webSocketSequence = 0

  constructor(private readonly deps: DiagnosticBufferDeps) {}

  attach(page: Page, tabId: string) {
    page.on("console", (message) => this.captureConsoleLog(tabId, message))
    page.on("pageerror", (error) => this.capturePageError(tabId, error))
    page.on("response", (response) => this.captureResponse(tabId, response))
    page.on("requestfailed", (request) =>
      this.captureRequestFailed(tabId, request)
    )
    page.on("websocket", (webSocket) =>
      this.captureWebSocket(tabId, webSocket)
    )
  }

  clearTab(tabId: string) {
    this.consoleLogsByTab.delete(tabId)
    this.pageErrorsByTab.delete(tabId)
    this.networkEventsByTab.delete(tabId)
    this.webSocketEventsByTab.delete(tabId)
  }

  clearAll() {
    this.consoleLogsByTab.clear()
    this.pageErrorsByTab.clear()
    this.networkEventsByTab.clear()
    this.webSocketEventsByTab.clear()
  }

  consoleLogsFor(tabId: string): ConsoleLogEntry[] {
    return this.consoleLogsByTab.get(tabId) ?? []
  }

  pageErrorsFor(tabId: string): PageErrorEntry[] {
    return this.pageErrorsByTab.get(tabId) ?? []
  }

  networkEventsFor(tabId: string): NetworkEventEntry[] {
    return this.networkEventsByTab.get(tabId) ?? []
  }

  webSocketEventsFor(tabId: string): WebSocketEventEntry[] {
    return this.webSocketEventsByTab.get(tabId) ?? []
  }

  findNewestNetworkEvent(tabId: string, options: NetworkQueryOptions) {
    const events = this.networkEventsFor(tabId)
    const matched = filterNetworkEvents(events, options)
    return matched[matched.length - 1]
  }

  findNewestWebSocketEvent(tabId: string, options: WebSocketQueryOptions) {
    const events = this.webSocketEventsFor(tabId)
    const matched = filterWebSocketEvents(events, options)
    return matched[matched.length - 1]
  }

  removeNetworkEvent(tabId: string, entry: NetworkEventEntry) {
    const events = this.networkEventsByTab.get(tabId)
    if (!events) return
    const index = events.lastIndexOf(entry)
    if (index >= 0) events.splice(index, 1)
  }

  removeWebSocketEvent(tabId: string, entry: WebSocketEventEntry) {
    const events = this.webSocketEventsByTab.get(tabId)
    if (!events) return
    const index = events.lastIndexOf(entry)
    if (index >= 0) events.splice(index, 1)
  }

  private captureConsoleLog(tabId: string, message: ConsoleMessage) {
    if (!this.deps.isTabTracked(tabId)) return
    const logs = this.consoleLogsByTab.get(tabId) ?? []
    const location = message.location()
    logs.push({
      level: normalizeConsoleLevel(message.type()),
      message: truncate(message.text(), MAX_CONSOLE_MESSAGE_LENGTH),
      timestamp: new Date().toISOString(),
      url: location.url ? boundedDiagnosticUrl(location.url) : undefined,
    })
    trimStart(logs, MAX_CONSOLE_LOGS_PER_TAB)
    this.consoleLogsByTab.set(tabId, logs)
  }

  private capturePageError(tabId: string, error: Error) {
    if (!this.deps.isTabTracked(tabId)) return
    const entry: PageErrorEntry = {
      message: truncate(error.message, MAX_DIAGNOSTIC_TEXT_LENGTH),
      timestamp: new Date().toISOString(),
    }
    if (error.name) {
      entry.name = truncate(error.name, MAX_DIAGNOSTIC_TEXT_LENGTH)
    }
    if (error.stack) {
      entry.stack = truncate(error.stack, MAX_DIAGNOSTIC_TEXT_LENGTH)
    }
    this.appendPageError(tabId, entry)
  }

  private captureResponse(tabId: string, response: Response) {
    if (!this.deps.isTabTracked(tabId)) return
    const request = response.request()
    this.appendNetworkEvent(tabId, {
      type: "response",
      timestamp: new Date().toISOString(),
      url: boundedDiagnosticUrl(response.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      statusText: truncate(response.statusText(), MAX_DIAGNOSTIC_TEXT_LENGTH),
      fromServiceWorker: response.fromServiceWorker(),
      frameId: this.deps.frameIdForRequest(tabId, request),
    })
  }

  private captureRequestFailed(tabId: string, request: Request) {
    if (!this.deps.isTabTracked(tabId)) return
    this.appendNetworkEvent(tabId, {
      type: "request_failed",
      timestamp: new Date().toISOString(),
      url: boundedDiagnosticUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      failureText: truncate(
        request.failure()?.errorText ?? "Request failed.",
        MAX_DIAGNOSTIC_TEXT_LENGTH
      ),
      frameId: this.deps.frameIdForRequest(tabId, request),
    })
  }

  private captureWebSocket(tabId: string, webSocket: PlaywrightWebSocket) {
    if (!this.deps.isTabTracked(tabId)) return
    const socketId = `ws_${++this.webSocketSequence}_${randomUUID().slice(0, 8)}`
    const url = boundedDiagnosticUrl(webSocket.url())
    this.appendWebSocketEvent(tabId, {
      socketId,
      type: "open",
      timestamp: new Date().toISOString(),
      url,
    })

    webSocket.on("framesent", (data) =>
      this.captureWebSocketFrame(tabId, socketId, url, "frame_sent", "sent", data)
    )
    webSocket.on("framereceived", (data) =>
      this.captureWebSocketFrame(tabId, socketId, url, "frame_received", "received", data)
    )
    webSocket.on("socketerror", () =>
      this.appendWebSocketEvent(tabId, {
        socketId,
        type: "socket_error",
        timestamp: new Date().toISOString(),
        url,
      })
    )
    webSocket.on("close", () =>
      this.appendWebSocketEvent(tabId, {
        socketId,
        type: "close",
        timestamp: new Date().toISOString(),
        url,
      })
    )
  }

  private captureWebSocketFrame(
    tabId: string,
    socketId: string,
    url: string,
    type: Extract<WebSocketEventType, "frame_sent" | "frame_received">,
    direction: WebSocketFrameDirection,
    data: WebSocketFrameData
  ) {
    this.appendWebSocketEvent(tabId, {
      socketId,
      type,
      timestamp: new Date().toISOString(),
      url,
      direction,
      payloadBytes: webSocketPayloadBytes(data.payload),
    })
  }

  appendPageError(tabId: string, entry: PageErrorEntry) {
    if (!this.deps.isTabTracked(tabId)) return
    const errors = this.pageErrorsByTab.get(tabId) ?? []
    errors.push(entry)
    trimStart(errors, MAX_DIAGNOSTIC_EVENTS_PER_TAB)
    this.pageErrorsByTab.set(tabId, errors)
  }

  appendNetworkEvent(tabId: string, entry: NetworkEventEntry) {
    if (!this.deps.isTabTracked(tabId)) return
    const events = this.networkEventsByTab.get(tabId) ?? []
    events.push(entry)
    trimStart(events, MAX_DIAGNOSTIC_EVENTS_PER_TAB)
    this.networkEventsByTab.set(tabId, events)
  }

  private appendWebSocketEvent(tabId: string, entry: WebSocketEventEntry) {
    if (!this.deps.isTabTracked(tabId)) return
    const events = this.webSocketEventsByTab.get(tabId) ?? []
    events.push(entry)
    trimStart(events, MAX_DIAGNOSTIC_EVENTS_PER_TAB)
    this.webSocketEventsByTab.set(tabId, events)
  }
}

export async function waitForBufferedEntry<TEntry>(
  timeout: number,
  findNewest: () => TEntry | undefined,
  label: string
): Promise<TEntry> {
  const existing = findNewest()
  if (existing) return existing

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(DIAGNOSTIC_WAIT_POLL_INTERVAL_MS, remaining))
    const entry = findNewest()
    if (entry) return entry
  }

  throw new BrowserToolError(
    "operation_failed",
    `Timed out after ${timeout}ms waiting for a matching ${label}.`
  )
}

export function removeBufferedEntry<TEntry>(
  buffers: Map<string, TEntry[]>,
  tabId: string,
  entry: TEntry
) {
  const entries = buffers.get(tabId)
  if (!entries) return
  const index = entries.lastIndexOf(entry)
  if (index >= 0) entries.splice(index, 1)
}
