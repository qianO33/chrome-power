import type { ElementHandle, Locator, Page } from "playwright"
import { BrowserToolError } from "./errors.js"
import type { SnapshotRegistry } from "./snapshot-registry.js"
import type { FrameRegistry } from "./frame-registry.js"
import { type FrameLike, locatorForQuery, withLocatorNotFound } from "./locator-query.js"
import {
  withSelectorError,
  withRefActionError,
} from "./target-resolution.js"
import {
  hasValue,
} from "./validation-utils.js"
import {
  ACTIONABLE_ELEMENT_SELECTOR,
  SENSITIVE_FIELD_HINTS,
  readSnapshotElement,
  readPointCandidateExtras,
} from "./page-projections.js"
import type {
  ElementBox,
  ElementBoxData,
  ElementScreenshotData,
  InspectPointCandidate,
  LocatorQuery,
  ViewportSize,
} from "./contracts.js"

type RuntimePage = { id: string; page: Page }

export type ElementVisualOptions = {
  tabId?: string
  frameId?: string
  ref?: string
  selector?: string
  locator?: LocatorQuery
  timeoutMs?: number
}

export type ResolvedElementVisualTarget =
  | { kind: "ref"; ref: string; handle: ElementHandle<Element> }
  | { kind: "selector"; locator: Locator }
  | { kind: "locator"; locator: Locator }

export type ElementVisualDeps = {
  snapshotRegistry: SnapshotRegistry
  frameRegistry: FrameRegistry
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function collectPointCandidates(
  page: Page,
  x: number,
  y: number,
  includeNonActionable: boolean
): Promise<InspectPointCandidate[]> {
  const arrayHandle = await page.evaluateHandle(
    ({ pointX, pointY }) => document.elementsFromPoint(pointX, pointY),
    { pointX: x, pointY: y }
  )
  const properties = await arrayHandle.getProperties()
  try {
    const entries = [...properties.entries()]
      .filter(([key]) => /^\d+$/.test(key))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
    const candidates: InspectPointCandidate[] = []
    for (const [key, handle] of entries) {
      const element = handle.asElement() as ElementHandle<Element> | null
      if (!element) continue
      const actionable = await element.evaluate(
        (node, selector) => node.matches(selector),
        ACTIONABLE_ELEMENT_SELECTOR
      )
      if (!includeNonActionable && !actionable) continue
      const metadata = await element.evaluate(
        readSnapshotElement,
        SENSITIVE_FIELD_HINTS
      )
      if (!metadata) continue
      const extras = await element.evaluate(readPointCandidateExtras)
      candidates.push({
        depth: Number(key),
        tag: metadata.tag,
        role: metadata.role,
        name: metadata.name,
        text: metadata.text,
        testId: extras.testId,
        actionable,
        box: metadata.box,
        locator: extras.locator,
        insideFrame: extras.insideFrame || undefined,
        frameInspectionDeferred: extras.insideFrame || undefined,
      })
      if (candidates.length >= 10) break
    }
    return candidates
  } finally {
    await Promise.all(
      [...properties.values()].map((handle) =>
        handle.dispose().catch(() => undefined)
      )
    )
    await arrayHandle.dispose().catch(() => undefined)
  }
}

export async function resolveElementVisualTarget(
  runtimePage: RuntimePage,
  options: ElementVisualOptions,
  deps: ElementVisualDeps
): Promise<ResolvedElementVisualTarget> {
  const count = Number(hasValue(options.ref)) +
    Number(hasValue(options.selector)) + Number(options.locator != null)
  if (count !== 1) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide exactly one element target: ref, selector, or locator."
    )
  }
  if (hasValue(options.ref)) {
    return {
      kind: "ref",
      ref: options.ref,
      handle: await deps.snapshotRegistry.resolveRef(runtimePage.id, options.ref, options.frameId),
    }
  }
  const frame = await deps.frameRegistry.resolve(runtimePage, options.frameId)
  if (hasValue(options.selector)) {
    return { kind: "selector", locator: frame.locator(options.selector) }
  }
  return {
    kind: "locator",
    locator: locatorForQuery(frame, options.locator as LocatorQuery, {
      allowIndex: true,
      action: "inspect element",
    }),
  }
}

export async function withElementVisualTargetError<T>(
  target: ResolvedElementVisualTarget,
  operation: () => Promise<T>
): Promise<T> {
  if (target.kind === "ref") {
    return withRefActionError(target.ref, operation)
  }
  if (target.kind === "selector") {
    return withSelectorError(operation)
  }
  return withLocatorNotFound(operation)
}

export async function elementVisualBox(
  target: ResolvedElementVisualTarget,
  viewport: ViewportSize,
  timeoutMs?: number
): Promise<ElementBoxData> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
  const box = await withElementVisualTargetError(target, async () => {
    const value = target.kind === "ref"
      ? await target.handle.boundingBox()
      : await target.locator.boundingBox({ timeout })
    if (!value) throw new Error("Element has no visible bounding box.")
    return value
  })
  const visible = await withElementVisualTargetError(target, () =>
    target.kind === "ref" ? target.handle.isVisible() : target.locator.isVisible()
  )
  const inViewport = box.x < viewport.width &&
    box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0
  return { box, visible, inViewport }
}

export function elementScreenshotData(
  buffer: Buffer,
  path: string,
  box: ElementBoxData,
  base64: boolean | undefined,
  screenshotInlineMaxBytes: number
): ElementScreenshotData {
  const includeInlineImage = base64 === true &&
    buffer.byteLength <= screenshotInlineMaxBytes
  return {
    ...box,
    scale: "css",
    path,
    sizeBytes: buffer.byteLength,
    base64: includeInlineImage ? buffer.toString("base64") : undefined,
    imageOmittedReason: base64 === true && !includeInlineImage ? "size_limit" : undefined,
    inlineImageLimitBytes: base64 === true && !includeInlineImage
      ? screenshotInlineMaxBytes
      : undefined,
  }
}
