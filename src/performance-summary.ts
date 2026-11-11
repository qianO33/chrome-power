import { createHash } from "node:crypto"

import type {
  AssetKind,
  PerformanceMetric,
  PerformanceResourceSummary,
  PerformanceSummaryData,
} from "./contracts.js"
import { boundedDiagnosticUrl } from "./validation-utils.js"

type PerformanceObserverProjection = {
  installed: boolean
  supportedEntryTypes: string[]
  lcp?: number
  cls?: number
  longTasks?: { count: number; total: number; max: number; blocking: number }
  interactionCount: number
  inp?: number
}

export type PerformancePageProjection = {
  observer?: PerformanceObserverProjection
  timeOrigin: number
  navigation?: Record<string, number | string>
  paints: Record<string, number>
  resources: Array<{
    identity: string
    url?: string
    scheme: string
    initiatorType: string
    startTime: number
    duration: number
    transferSize: number
    encodedBodySize: number
    decodedBodySize: number
  }>
}

export type PerformanceSummaryOptions = {
  resourceKinds?: AssetKind[]
  minResourceDurationMs?: number
  minTransferBytes?: number
  sortResourcesBy?: "duration" | "transfer_size" | "decoded_size"
  resourceLimit?: number
}

export function buildPerformanceSummary(input: {
  frameId: string
  frameUrl: string
  projection: PerformancePageProjection
  options: PerformanceSummaryOptions
}): PerformanceSummaryData {
  const observer = input.projection.observer
  const navigation = input.projection.navigation
  const number = (name: string) => {
    const value = navigation?.[name]
    return typeof value === "number" ? value : undefined
  }
  const duration = (end: string, start: string) => {
    const endValue = number(end)
    const startValue = number(start)
    if (endValue == null || startValue == null || endValue < startValue || endValue === 0) {
      return undefined
    }
    return roundMetric(endValue - startValue)
  }
  const phases = Object.fromEntries(
    Object.entries({
      redirectMs: duration("redirectEnd", "redirectStart"),
      dnsMs: duration("domainLookupEnd", "domainLookupStart"),
      connectMs: duration("connectEnd", "connectStart"),
      tlsMs: duration("connectEnd", "secureConnectionStart"),
      requestMs: duration("responseStart", "requestStart"),
      responseMs: duration("responseEnd", "responseStart"),
      domProcessingMs: duration("domComplete", "responseEnd"),
      domContentLoadedMs: duration(
        "domContentLoadedEventEnd",
        "domContentLoadedEventStart"
      ),
      loadEventMs: duration("loadEventEnd", "loadEventStart"),
      totalUntilLoadMs: duration("loadEventEnd", "startTime"),
      ttfbMs: duration("responseStart", "requestStart"),
    }).filter((entry): entry is [string, number] => entry[1] != null)
  )
  const resourceRecords: PerformanceResourceSummary[] = input.projection.resources.map(
    (resource) => {
      const sizeAvailable =
        resource.transferSize > 0 ||
        resource.encodedBodySize > 0 ||
        resource.decodedBodySize > 0
      return {
        kind: assetKindFromInitiator(resource.initiatorType),
        url: resource.url ? boundedDiagnosticUrl(resource.url) : undefined,
        scheme: resource.scheme,
        initiatorType: resource.initiatorType,
        startTimeMs: roundMetric(resource.startTime),
        durationMs: roundMetric(resource.duration),
        sizeAvailable,
        transferSize: sizeAvailable ? resource.transferSize : undefined,
        encodedBodySize: sizeAvailable ? resource.encodedBodySize : undefined,
        decodedBodySize: sizeAvailable ? resource.decodedBodySize : undefined,
      }
    }
  )
  const byKind: PerformanceSummaryData["resources"]["byKind"] = {}
  let totalDurationMs = 0
  let totalTransferBytes = 0
  let totalDecodedBytes = 0
  let transferBytesAvailable = false
  for (const resource of resourceRecords) {
    totalDurationMs += resource.durationMs
    const bucket = (byKind[resource.kind] ??= { count: 0, durationMs: 0 })
    bucket.count += 1
    bucket.durationMs = roundMetric(bucket.durationMs + resource.durationMs)
    if (resource.sizeAvailable) {
      transferBytesAvailable = true
      totalTransferBytes += resource.transferSize ?? 0
      totalDecodedBytes += resource.decodedBodySize ?? 0
      bucket.transferBytes = (bucket.transferBytes ?? 0) + (resource.transferSize ?? 0)
    }
  }
  const kinds = input.options.resourceKinds && new Set(input.options.resourceKinds)
  let filtered = resourceRecords.filter((resource) => {
    if (kinds && !kinds.has(resource.kind)) return false
    if (
      input.options.minResourceDurationMs != null &&
      resource.durationMs < input.options.minResourceDurationMs
    ) return false
    if (
      input.options.minTransferBytes != null &&
      (!resource.sizeAvailable ||
        (resource.transferSize ?? 0) < input.options.minTransferBytes)
    ) return false
    return true
  })
  const sortBy = input.options.sortResourcesBy ?? "duration"
  filtered.sort((left, right) => {
    const metric = (resource: PerformanceResourceSummary) =>
      sortBy === "duration"
        ? resource.durationMs
        : sortBy === "transfer_size"
          ? resource.transferSize
          : resource.decodedBodySize
    const leftValue = metric(left)
    const rightValue = metric(right)
    if (leftValue == null) return rightValue == null ? left.startTimeMs - right.startTimeMs : 1
    if (rightValue == null) return -1
    return rightValue - leftValue || left.startTimeMs - right.startTimeMs
  })
  const resourceLimit = input.options.resourceLimit ?? 10
  const slowest = filtered.slice(0, resourceLimit)
  const supported = observer?.supportedEntryTypes ?? []
  return {
    frameId: input.frameId,
    frameUrl: safeAssetFrameUrl(input.frameUrl),
    navigation: {
      navigationId: `nav_${createHash("sha256")
        .update(`${input.frameId}\0${input.projection.timeOrigin}`)
        .digest("hex")
        .slice(0, 12)}`,
      startedAt: new Date(input.projection.timeOrigin).toISOString(),
      type: typeof navigation?.type === "string" ? navigation.type : undefined,
      phases,
    },
    vitals: {
      thresholdVersion: "web-vitals-2024",
      fcp: performanceMetric(input.projection.paints["first-contentful-paint"], "ms", 1800, 3000, "not_observed"),
      lcp: performanceMetric(observer?.lcp, "ms", 2500, 4000, observer ? "not_observed" : "observer_unavailable"),
      cls: performanceMetric(observer?.cls, "score", 0.1, 0.25, observer ? "not_observed" : "observer_unavailable"),
      inp: performanceMetric(observer?.inp, "ms", 200, 500, observer?.interactionCount ? "not_observed" : "no_interactions"),
    },
    longTasks: observer?.longTasks
      ? {
          available: true,
          count: observer.longTasks.count,
          totalDurationMs: roundMetric(observer.longTasks.total),
          maxDurationMs: roundMetric(observer.longTasks.max),
          totalBlockingTimeMs: roundMetric(observer.longTasks.blocking),
        }
      : {
          available: false,
          count: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          totalBlockingTimeMs: 0,
        },
    resources: {
      totalCount: resourceRecords.length,
      filteredCount: filtered.length,
      returnedCount: slowest.length,
      truncated: filtered.length > slowest.length,
      totalDurationMs: roundMetric(totalDurationMs),
      transferBytesAvailable,
      totalTransferBytes: transferBytesAvailable ? totalTransferBytes : undefined,
      totalDecodedBytes: transferBytesAvailable ? totalDecodedBytes : undefined,
      byKind,
      slowest,
    },
    completeness: {
      earlyObserverInstalled: observer?.installed === true,
      supportedEntryTypes: supported,
      caveats: [
        "Automated INP reflects only interactions performed in this browser navigation.",
        "Resource sizes may be unavailable for cached or cross-origin resources.",
        "Scheduler timings vary across machines and runs.",
      ],
    },
  }
}

export function performanceMetric(
  value: number | undefined,
  unit: PerformanceMetric["unit"],
  good: number,
  poor: number,
  reason: string
): PerformanceMetric {
  if (value == null) return { available: false, unit, reason }
  const rounded = roundMetric(value)
  return {
    available: true,
    value: rounded,
    unit,
    rating:
      rounded <= good
        ? "good"
        : rounded > poor
          ? "poor"
          : "needs_improvement",
  }
}

export function roundMetric(value: number) {
  return Math.round(value * 1000) / 1000
}

function assetKindFromInitiator(value: string): AssetKind {
  switch (value) {
    case "img": return "image"
    case "css": return "stylesheet"
    case "script": return "script"
    case "video": return "video"
    case "audio": return "audio"
    default: return "other"
  }
}

function safeAssetFrameUrl(value: string) {
  return value.startsWith("data:")
    ? "data:[hidden]"
    : boundedDiagnosticUrl(value)
}
