import {
  type ConsoleLogEntry,
  type ConsoleLogLevel,
  type NetworkEventEntry,
  type NetworkEventType,
  type NetworkStatusClassCounts,
  type NetworkSummaryData,
  type PageErrorEntry,
  type WebSocketDirectionCounts,
  type WebSocketEventEntry,
  type WebSocketEventType,
  type WebSocketSummaryData,
} from "./contracts.js"
import { BrowserToolError } from "./errors.js"

export type NetworkQueryOptions = {
  types?: NetworkEventType[]
  filter?: string
  statusMin?: number
  statusMax?: number
}

export type WebSocketQueryOptions = {
  types?: WebSocketEventType[]
  filter?: string
}

export function normalizeConsoleLevel(level: string): ConsoleLogLevel {
  switch (level) {
    case "debug":
      return "debug"
    case "info":
      return "info"
    case "error":
      return "error"
    case "warn":
    case "warning":
      return "warn"
    case "log":
    default:
      return "log"
  }
}

export function filterConsoleLogs(
  entries: ConsoleLogEntry[],
  options: { levels?: Array<ConsoleLogLevel | "warning">; filter?: string }
) {
  const normalizedLevels = new Set(options.levels?.map(normalizeConsoleLevel))
  return entries.filter((entry) => {
    if (normalizedLevels.size > 0 && !normalizedLevels.has(entry.level)) {
      return false
    }
    return options.filter == null || entry.message.includes(options.filter)
  })
}

export function findNewestConsoleLog(
  entries: ConsoleLogEntry[],
  options: { levels?: Array<ConsoleLogLevel | "warning">; filter?: string }
) {
  const matched = filterConsoleLogs(entries, options)
  return matched[matched.length - 1]
}

export function filterPageErrors(
  entries: PageErrorEntry[],
  options: { filter?: string }
) {
  return entries.filter(
    (entry) =>
      options.filter == null || pageErrorMatchesFilter(entry, options.filter)
  )
}

export function findNewestPageError(
  entries: PageErrorEntry[],
  options: { filter?: string }
) {
  const matched = filterPageErrors(entries, options)
  return matched[matched.length - 1]
}

function pageErrorMatchesFilter(entry: PageErrorEntry, filter: string) {
  return [entry.message, entry.name, entry.stack].some((value) =>
    value?.includes(filter)
  )
}

export function validateNetworkStatusRange(options: NetworkQueryOptions) {
  if (
    options.statusMin != null &&
    options.statusMax != null &&
    options.statusMin > options.statusMax
  ) {
    throw new BrowserToolError(
      "invalid_request",
      "statusMin must be less than or equal to statusMax."
    )
  }
}

export function filterNetworkEvents(
  events: NetworkEventEntry[],
  options: NetworkQueryOptions
) {
  const types = new Set(options.types ?? [])
  return events.filter((entry) => {
    if (types.size > 0 && !types.has(entry.type)) return false
    if (options.statusMin != null) {
      if (entry.status == null || entry.status < options.statusMin) {
        return false
      }
    }
    if (options.statusMax != null) {
      if (entry.status == null || entry.status > options.statusMax) {
        return false
      }
    }
    if (options.filter == null) return true
    return networkEventMatchesFilter(entry, options.filter)
  })
}

function networkEventMatchesFilter(entry: NetworkEventEntry, filter: string) {
  return [
    entry.url,
    entry.method,
    entry.resourceType,
    entry.statusText,
    entry.failureText,
    entry.status == null ? undefined : String(entry.status),
  ].some((value) => value?.includes(filter))
}

export function summarizeNetworkEvents(
  events: NetworkEventEntry[],
  matchingEventCount: number,
  limit: number
): NetworkSummaryData {
  const byType: Record<NetworkEventType, number> = {
    response: 0,
    request_failed: 0,
  }
  const byMethod: Record<string, number> = {}
  const byResourceType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const byStatusClass: NetworkStatusClassCounts = {
    "1xx": 0,
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0,
    other: 0,
    unknown: 0,
  }
  let failedRequestCount = 0
  let serviceWorkerResponseCount = 0

  for (const event of events) {
    byType[event.type] += 1
    incrementCount(byMethod, event.method)
    incrementCount(byResourceType, event.resourceType)

    if (event.status == null) {
      byStatusClass.unknown += 1
    } else {
      incrementCount(byStatus, String(event.status))
      byStatusClass[networkStatusClass(event.status)] += 1
    }

    if (event.type === "request_failed") {
      failedRequestCount += 1
    }
    if (event.fromServiceWorker === true) {
      serviceWorkerResponseCount += 1
    }
  }

  const first = events[0]
  const last = events[events.length - 1]
  return {
    matchingEventCount,
    eventsSummarized: events.length,
    limit,
    firstTimestamp: first?.timestamp,
    lastTimestamp: last?.timestamp,
    byType,
    byMethod,
    byResourceType,
    byStatus,
    byStatusClass,
    failedRequestCount,
    serviceWorkerResponseCount,
  }
}

function networkStatusClass(status: number): keyof NetworkStatusClassCounts {
  if (status >= 100 && status <= 199) return "1xx"
  if (status >= 200 && status <= 299) return "2xx"
  if (status >= 300 && status <= 399) return "3xx"
  if (status >= 400 && status <= 499) return "4xx"
  if (status >= 500 && status <= 599) return "5xx"
  return "other"
}

export function filterWebSocketEvents(
  events: WebSocketEventEntry[],
  options: WebSocketQueryOptions
) {
  const types = new Set(options.types ?? [])
  return events.filter((entry) => {
    if (types.size > 0 && !types.has(entry.type)) return false
    if (options.filter == null) return true
    return webSocketEventMatchesFilter(entry, options.filter)
  })
}

function webSocketEventMatchesFilter(
  entry: WebSocketEventEntry,
  filter: string
) {
  return [
    entry.socketId,
    entry.type,
    entry.url,
    entry.direction,
    entry.payloadBytes == null ? undefined : String(entry.payloadBytes),
  ].some((value) => value?.includes(filter))
}

export function summarizeWebSocketEvents(
  events: WebSocketEventEntry[],
  matchingEventCount: number,
  limit: number
): WebSocketSummaryData {
  const byType: Record<WebSocketEventType, number> = {
    open: 0,
    frame_sent: 0,
    frame_received: 0,
    socket_error: 0,
    close: 0,
  }
  const byDirection: WebSocketDirectionCounts = {
    sent: 0,
    received: 0,
    unknown: 0,
  }
  const socketIds = new Set<string>()
  let frameEventCount = 0
  let totalPayloadBytes = 0
  let sentPayloadBytes = 0
  let receivedPayloadBytes = 0
  let maxPayloadBytes = 0

  for (const event of events) {
    byType[event.type] += 1
    socketIds.add(event.socketId)

    if (event.direction === "sent") {
      byDirection.sent += 1
    } else if (event.direction === "received") {
      byDirection.received += 1
    } else {
      byDirection.unknown += 1
    }

    if (
      event.type === "frame_sent" ||
      event.type === "frame_received"
    ) {
      frameEventCount += 1
    }

    if (event.payloadBytes != null) {
      totalPayloadBytes += event.payloadBytes
      maxPayloadBytes = Math.max(maxPayloadBytes, event.payloadBytes)
      if (event.direction === "sent") {
        sentPayloadBytes += event.payloadBytes
      } else if (event.direction === "received") {
        receivedPayloadBytes += event.payloadBytes
      }
    }
  }

  const first = events[0]
  const last = events[events.length - 1]
  return {
    matchingEventCount,
    eventsSummarized: events.length,
    limit,
    firstTimestamp: first?.timestamp,
    lastTimestamp: last?.timestamp,
    byType,
    byDirection,
    socketCount: socketIds.size,
    frameEventCount,
    totalPayloadBytes,
    sentPayloadBytes,
    receivedPayloadBytes,
    maxPayloadBytes,
  }
}

export function webSocketPayloadBytes(payload: string | Buffer) {
  return Buffer.isBuffer(payload)
    ? payload.byteLength
    : Buffer.byteLength(payload, "utf8")
}

function incrementCount(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1
}
