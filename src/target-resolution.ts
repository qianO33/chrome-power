import { BrowserToolError } from "./errors.js"
import {
  hasValue,
  errorMessage,
  isDetachedRefError,
  sanitizeDownloadFilename,
} from "./validation-utils.js"

export type PointerTarget =
  | { kind: "ref"; ref: string }
  | { kind: "selector"; selector: string }
  | { kind: "point"; x: number; y: number }

export type ElementTarget =
  | { kind: "ref"; ref: string }
  | { kind: "selector"; selector: string }

export type DragOptions = {
  tabId?: string
  fromRef?: string
  fromSelector?: string
  fromX?: number
  fromY?: number
  toRef?: string
  toSelector?: string
  toX?: number
  toY?: number
  steps?: number
  timeoutMs?: number
}

export type SelectOptionOptions = {
  tabId?: string
  frameId?: string
  ref?: string
  selector?: string
  value?: string
  label?: string
  index?: number
  timeoutMs?: number
}

export type ExpectNavigationAction = {
  type: "click" | "double_click" | "press"
  frameId?: string
  ref?: string
  selector?: string
  x?: number
  y?: number
  key?: string
}

export type ExpectDownloadAction = ExpectNavigationAction
export type ExpectFileChooserAction = ExpectNavigationAction

export function resolvePointerTarget(
  options: {
    frameId?: string
    ref?: string
    selector?: string
    x?: number
    y?: number
  },
  action: string
): PointerTarget {
  const hasRef = hasValue(options.ref)
  const hasSelector = hasValue(options.selector)
  const hasAnyCoordinate = options.x != null || options.y != null
  const hasPoint = options.x != null && options.y != null

  if (hasAnyCoordinate && !hasPoint) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide both x and y coordinates."
    )
  }

  if (hasPoint && hasValue(options.frameId)) {
    throw new BrowserToolError(
      "invalid_request",
      `${action} coordinates are page viewport coordinates and cannot be combined with frameId.`
    )
  }

  const targetCount =
    Number(hasRef) + Number(hasSelector) + Number(hasPoint)
  if (targetCount !== 1) {
    throw new BrowserToolError(
      "invalid_request",
      `Provide exactly one ${action} target: ref, selector, or x/y coordinates.`
    )
  }

  if (hasRef) return { kind: "ref", ref: options.ref as string }
  if (hasSelector) {
    return { kind: "selector", selector: options.selector as string }
  }
  return { kind: "point", x: options.x as number, y: options.y as number }
}

export function resolveDragEndpoint(
  options: DragOptions,
  endpoint: "from" | "to"
): PointerTarget {
  const target =
    endpoint === "from"
      ? {
          ref: options.fromRef,
          selector: options.fromSelector,
          x: options.fromX,
          y: options.fromY,
        }
      : {
          ref: options.toRef,
          selector: options.toSelector,
          x: options.toX,
          y: options.toY,
        }

  return resolvePointerTarget(target, `${endpoint} drag endpoint`)
}

export function resolveSelectOption(options: SelectOptionOptions) {
  const hasValueOption = hasValue(options.value)
  const hasLabelOption = hasValue(options.label)
  const hasIndexOption = options.index != null

  if (
    Number(hasValueOption) + Number(hasLabelOption) + Number(hasIndexOption) ===
    0
  ) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide a select option by value, label, or index."
    )
  }

  return {
    value: hasValueOption ? options.value : undefined,
    label: hasLabelOption ? options.label : undefined,
    index: hasIndexOption ? options.index : undefined,
  }
}

export function resolveElementTarget(
  options: { ref?: string; selector?: string },
  action: string
): ElementTarget {
  const hasRef = hasValue(options.ref)
  const hasSelector = hasValue(options.selector)

  if (Number(hasRef) + Number(hasSelector) !== 1) {
    throw new BrowserToolError(
      "invalid_request",
      `Provide exactly one ${action} target: ref or selector.`
    )
  }

  if (hasRef) return { kind: "ref", ref: options.ref as string }
  return { kind: "selector", selector: options.selector as string }
}

export function resolveOptionalElementTarget(
  options: { ref?: string; selector?: string },
  action: string
):
  | { kind: "ref"; ref: string }
  | { kind: "selector"; selector: string }
  | { kind: "page" } {
  const hasRef = hasValue(options.ref)
  const hasSelector = hasValue(options.selector)

  if (hasRef && hasSelector) {
    throw new BrowserToolError(
      "invalid_request",
      `Provide at most one ${action} target: ref or selector.`
    )
  }

  if (hasRef) return { kind: "ref", ref: options.ref as string }
  if (hasSelector) {
    return { kind: "selector", selector: options.selector as string }
  }
  return { kind: "page" }
}

export function resolveWaitTarget(options: {
  ref?: string
  selector?: string
  loadState?: "load" | "domcontentloaded" | "networkidle"
}):
  | { kind: "ref"; ref: string }
  | { kind: "selector"; selector: string }
  | {
      kind: "loadState"
      loadState: "load" | "domcontentloaded" | "networkidle"
    }
  | { kind: "timeout" } {
  const hasRef = hasValue(options.ref)
  const hasSelector = hasValue(options.selector)
  const hasLoadState = options.loadState != null
  const targetCount =
    Number(hasRef) + Number(hasSelector) + Number(hasLoadState)

  if (targetCount > 1) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide at most one wait-target: ref, selector, or loadState."
    )
  }

  if (hasRef) return { kind: "ref", ref: options.ref as string }
  if (hasSelector) {
    return { kind: "selector", selector: options.selector as string }
  }
  if (options.loadState) {
    return { kind: "loadState", loadState: options.loadState }
  }
  return { kind: "timeout" }
}

export function resolveTriggerAction<TAction extends ExpectNavigationAction>(
  action: TAction,
  mode: "navigation" | "popup" | "download" | "upload"
): TAction {
  if (action == null || typeof action !== "object") {
    throw new BrowserToolError(
      "invalid_request",
      `Provide a ${mode} action.`
    )
  }

  if (action.type === "click" || action.type === "double_click") {
    if (hasValue(action.key)) {
      throw new BrowserToolError(
        "invalid_request",
        `Only press ${mode} actions can include key.`
      )
    }
    resolvePointerTarget(
      action,
      action.type === "double_click" ? "double click" : "click"
    )
    return action
  }

  if (action.type === "press") {
    if (action.x != null || action.y != null) {
      throw new BrowserToolError(
        "invalid_request",
        `Press ${mode} actions support ref or selector targets only.`
      )
    }
    if (!hasValue(action.key)) {
      throw new BrowserToolError(
        "invalid_request",
        `Press ${mode} action requires key.`
      )
    }
    resolveElementTarget(action, "press")
    return action
  }

  throw new BrowserToolError(
    "invalid_request",
    `Unsupported ${mode} action: ${(action as { type?: string }).type ?? ""}`
  )
}

export function resolveExpectNavigationAction(
  action: ExpectNavigationAction
): ExpectNavigationAction {
  return resolveTriggerAction(action, "navigation")
}

export function resolveExpectDownloadAction(
  action: ExpectDownloadAction
): ExpectDownloadAction {
  return resolveTriggerAction(action, "download")
}

export function resolveExpectFileChooserAction(
  action: ExpectFileChooserAction
): ExpectFileChooserAction {
  return resolveTriggerAction(action, "upload")
}

export function resolveDownloadFilename(
  requestedFilename: string | undefined,
  suggestedFilename: string
) {
  const sanitized = sanitizeDownloadFilename(
    requestedFilename ?? suggestedFilename
  )
  if (!sanitized) {
    if (requestedFilename != null) {
      throw new BrowserToolError(
        "invalid_request",
        "Download filename must contain a safe filename component."
      )
    }
    return "download"
  }
  return sanitized
}

export async function withSelectorError<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof BrowserToolError) throw error
    throw new BrowserToolError("selector_not_found", errorMessage(error))
  }
}

export async function withRefActionError<T>(
  ref: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof BrowserToolError) throw error
    if (isDetachedRefError(error)) {
      throw new BrowserToolError(
        "element_ref_not_found",
        `Element ref is detached or expired: ${ref}. Take a new browser_snapshot for this tab.`
      )
    }
    throw error
  }
}
