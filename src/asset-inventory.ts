import { createHash } from "node:crypto"

import type {
  AssetInventoryData,
  AssetKind,
  AssetOriginRelationship,
  AssetRecord,
  AssetSortMode,
  AssetObservationState,
  NetworkEventEntry,
} from "./contracts.js"
import { boundedDiagnosticUrl } from "./validation-utils.js"

type AssetAccumulator = AssetRecord & { discovery: number }

export type DomAssetProjection = {
  identity: string
  url?: string
  scheme: string
  kind: AssetKind
  tagName?: string
  loading?: string
  renderedWidth?: number
  renderedHeight?: number
  intrinsicWidth?: number
  intrinsicHeight?: number
  viewBox?: { x: number; y: number; width: number; height: number }
  inline?: boolean
}

export type PerformanceAssetProjection = {
  identity: string
  url?: string
  scheme: string
  initiatorType: string
  startTime: number
  duration: number
  transferSize: number
  encodedBodySize: number
  decodedBodySize: number
}

export type AssetsOptions = {
  kinds?: AssetKind[]
  states?: AssetObservationState[]
  origins?: AssetOriginRelationship[]
  filter?: string
  minTransferBytes?: number
  sortBy?: AssetSortMode
  limit?: number
}

export function buildAssetInventory(input: {
  frameId: string
  frameUrl: string
  dom: DomAssetProjection[]
  performance: PerformanceAssetProjection[]
  network: NetworkEventEntry[]
  backgroundElementsScanned: number
  backgroundScanTruncated: boolean
  options: AssetsOptions
}): AssetInventoryData {
  const records = new Map<string, AssetAccumulator>()
  let discovery = 0
  const keyFor = (kind: AssetKind, identity: string) => `${kind}\0${identity}`
  const create = (
    kind: AssetKind,
    identity: string,
    url: string | undefined,
    scheme: string
  ) => {
    const key = keyFor(kind, identity)
    let record = records.get(key)
    if (!record) {
      record = {
        assetId: `asset_${createHash("sha256")
          .update(`${input.frameId}\0${kind}\0${identity}`)
          .digest("hex")
          .slice(0, 12)}`,
        kind,
        state: "declared_unobserved",
        origin: assetOrigin(url, scheme, input.frameUrl),
        provenance: [],
        occurrenceCount: 0,
        url: url ? boundedDiagnosticUrl(url) : undefined,
        scheme,
        discovery: discovery++,
      }
      records.set(key, record)
    }
    return record
  }
  for (const item of input.dom) {
    const record = create(item.kind, item.identity, item.url, item.scheme)
    record.occurrenceCount += 1
    addUnique(record.provenance, item.inline ? "inline" : "dom")
    if (item.inline) record.state = "inline"
    if (item.tagName) record.tagNames = uniqueStrings(record.tagNames, item.tagName)
    if (item.loading) record.loading = uniqueStrings(record.loading, item.loading)
    if (item.renderedWidth != null && item.renderedHeight != null) {
      mergeRendered(record, item.renderedWidth, item.renderedHeight)
    }
    record.intrinsicWidth = maxDefined(record.intrinsicWidth, item.intrinsicWidth)
    record.intrinsicHeight = maxDefined(record.intrinsicHeight, item.intrinsicHeight)
    record.viewBox ??= item.viewBox
  }
  const findObservedRecord = (kind: AssetKind, identity: string) => {
    const exact = records.get(keyFor(kind, identity))
    if (exact) return exact
    const candidates = [...records.entries()]
      .filter(([key]) => key.endsWith(`\0${identity}`))
      .map(([, value]) => value)
    return candidates.length === 1
      ? candidates[0]
      : create(kind, identity, safeOrdinaryAssetUrl(identity), assetScheme(identity))
  }
  for (const item of input.performance) {
    const kind = assetKindFromInitiator(item.initiatorType)
    const record = findObservedRecord(kind, item.identity)
    addUnique(record.provenance, "performance")
    if (record.state === "declared_unobserved") record.state = "observed"
    record.occurrenceCount ||= 1
    const sizeAvailable =
      item.transferSize > 0 || item.encodedBodySize > 0 || item.decodedBodySize > 0
    record.performance = {
      initiatorType: item.initiatorType,
      startTime: item.startTime,
      duration: item.duration,
      sizeAvailable,
      transferSize: sizeAvailable ? item.transferSize : undefined,
      encodedBodySize: sizeAvailable ? item.encodedBodySize : undefined,
      decodedBodySize: sizeAvailable ? item.decodedBodySize : undefined,
    }
  }
  for (const event of input.network) {
    const identity = safeAssetIdentity(event.url)
    const kind = assetKindFromResourceType(event.resourceType)
    const record = findObservedRecord(kind, identity.identity)
    addUnique(record.provenance, "network")
    record.occurrenceCount ||= 1
    const { url: _url, frameId: _frameId, ...network } = event
    record.network = network
    record.state =
      event.type === "request_failed" || (event.status != null && event.status >= 400)
        ? "failed"
        : "loaded"
  }
  let values = [...records.values()]
  const kinds = input.options.kinds && new Set(input.options.kinds)
  const states = input.options.states && new Set(input.options.states)
  const origins = input.options.origins && new Set(input.options.origins)
  const filter = input.options.filter?.toLowerCase()
  values = values.filter((record) => {
    if (kinds && !kinds.has(record.kind)) return false
    if (states && !states.has(record.state)) return false
    if (origins && !origins.has(record.origin)) return false
    if (
      input.options.minTransferBytes != null &&
      (!record.performance?.sizeAvailable ||
        (record.performance.transferSize ?? 0) < input.options.minTransferBytes)
    ) return false
    if (!filter) return true
    return [
      record.url,
      record.kind,
      record.state,
      record.origin,
      ...record.provenance,
      ...(record.tagNames ?? []),
    ].some((value) => value?.toLowerCase().includes(filter))
  })
  const matchingCount = values.length
  values.sort(assetComparator(input.options.sortBy ?? "discovery"))
  const limit = input.options.limit ?? DEFAULT_ASSET_LIMIT
  const assets = values.slice(0, limit).map(({ discovery: _discovery, ...record }) => record)
  return {
    frameId: input.frameId,
    frameUrl: safeAssetFrameUrl(input.frameUrl),
    assets,
    totalDiscovered: records.size,
    matchingCount,
    returnedCount: assets.length,
    limit,
    truncated: matchingCount > assets.length,
    completeness: {
      domScanned: true,
      domOccurrenceCount: input.dom.length,
      backgroundElementsScanned: input.backgroundElementsScanned,
      backgroundScanTruncated: input.backgroundScanTruncated,
      performanceEntryCount: input.performance.length,
      networkEventCount: input.network.length,
      caveats: [
        "Lazy, dynamically removed, cross-origin timing-restricted, or cleared network observations may be incomplete.",
        "Transfer sizes come only from browser Resource Timing and may be unavailable for cached or cross-origin assets.",
      ],
    },
  }
}

const DEFAULT_ASSET_LIMIT = 100

function safeAssetIdentity(value: string) {
  if (value.startsWith("data:")) {
    return {
      identity: `data:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`,
      scheme: "data",
    }
  }
  return { identity: value, url: value, scheme: assetScheme(value) }
}

function safeAssetFrameUrl(value: string) {
  return value.startsWith("data:")
    ? "data:[hidden]"
    : boundedDiagnosticUrl(value)
}

function safeOrdinaryAssetUrl(identity: string) {
  return identity.startsWith("data:") ? undefined : identity
}

function assetScheme(value: string) {
  try {
    return new URL(value).protocol.replace(":", "")
  } catch {
    return "unknown"
  }
}

function assetOrigin(
  url: string | undefined,
  scheme: string,
  frameUrl: string
): AssetOriginRelationship {
  if (scheme === "inline" || scheme === "data") return "inline"
  if (!url) return "opaque"
  try {
    const asset = new URL(url)
    const frame = new URL(frameUrl)
    if (asset.origin === "null") return "opaque"
    return asset.origin === frame.origin ? "same_origin" : "cross_origin"
  } catch {
    return "opaque"
  }
}

function assetKindFromResourceType(value: string): AssetKind {
  switch (value) {
    case "image": return "image"
    case "font": return "font"
    case "stylesheet": return "stylesheet"
    case "script": return "script"
    case "media": return "video"
    default: return "other"
  }
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

function addUnique<T>(values: T[], value: T) {
  if (!values.includes(value)) values.push(value)
}

function uniqueStrings(values: string[] | undefined, value: string) {
  const next = values ?? []
  addUnique(next, value)
  return next
}

function maxDefined(current: number | undefined, candidate: number | undefined) {
  if (candidate == null) return current
  return current == null ? candidate : Math.max(current, candidate)
}

function mergeRendered(record: AssetAccumulator, width: number, height: number) {
  record.rendered ??= {
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
  }
  record.rendered.minWidth = Math.min(record.rendered.minWidth, width)
  record.rendered.minHeight = Math.min(record.rendered.minHeight, height)
  record.rendered.maxWidth = Math.max(record.rendered.maxWidth, width)
  record.rendered.maxHeight = Math.max(record.rendered.maxHeight, height)
}

function assetComparator(sortBy: AssetSortMode) {
  return (left: AssetAccumulator, right: AssetAccumulator) => {
    const metric = (record: AssetAccumulator) => {
      if (sortBy === "transfer_size") return record.performance?.transferSize
      if (sortBy === "decoded_size") return record.performance?.decodedBodySize
      if (sortBy === "rendered_area" && record.rendered) {
        return record.rendered.maxWidth * record.rendered.maxHeight
      }
      return undefined
    }
    if (sortBy !== "discovery") {
      const leftMetric = metric(left)
      const rightMetric = metric(right)
      if (leftMetric != null || rightMetric != null) {
        if (leftMetric == null) return 1
        if (rightMetric == null) return -1
        if (leftMetric !== rightMetric) return rightMetric - leftMetric
      }
    }
    return left.discovery - right.discovery
  }
}
