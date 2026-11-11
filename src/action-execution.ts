import type { Dialog, Page } from "playwright"
import { BrowserToolError } from "./errors.js"
import type { SnapshotRegistry } from "./snapshot-registry.js"
import type { FrameRegistry } from "./frame-registry.js"
import type { FrameLike } from "./locator-query.js"
import {
  resolvePointerTarget,
  resolveElementTarget,
  withSelectorError,
  withRefActionError,
  type PointerTarget,
  type ElementTarget,
  type ExpectNavigationAction,
} from "./target-resolution.js"
import { pendingDialogError, centerOfBox } from "./validation-utils.js"

type RuntimePage = { id: string; page: Page }
type Point = { x: number; y: number }

const DIALOG_BLOCKING_EVALUATE_TIMEOUT_MS = 30_000

export type ActionDeps = {
  snapshotRegistry: SnapshotRegistry
  dialogs: Map<string, Dialog>
  frameRegistry: FrameRegistry
}

export async function performActionOrCaptureDialog(
  runtimePage: RuntimePage,
  operation: () => Promise<unknown>,
  deps: ActionDeps
): Promise<void> {
  let removeDialogListener: (() => void) | undefined
  const dialogPromise = new Promise<"dialog">((resolve) => {
    const handler = (dialog: Dialog) => {
      deps.dialogs.set(runtimePage.id, dialog)
      resolve("dialog")
    }
    removeDialogListener = () => runtimePage.page.off("dialog", handler)
    runtimePage.page.once("dialog", handler)
  })

  const actionPromise = operation().then(() => "action" as const)

  try {
    const winner = await Promise.race([actionPromise, dialogPromise])
    removeDialogListener?.()
    if (winner === "dialog") {
      actionPromise.catch(() => undefined)
    }
  } catch (error) {
    removeDialogListener?.()
    throw error
  }
}

export async function evaluateWithDialogGuard<T>(
  runtimePage: RuntimePage,
  operationName: string,
  operation: () => Promise<T>,
  deps: Pick<ActionDeps, "dialogs">
): Promise<T> {
  if (deps.dialogs.has(runtimePage.id)) {
    throw pendingDialogError(operationName)
  }

  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new BrowserToolError(
          "operation_failed",
          `${operationName} timed out after ${DIALOG_BLOCKING_EVALUATE_TIMEOUT_MS}ms. The tab may have an unhandled JavaScript dialog; call browser_dialog with action "handle" first.`
        )
      )
    }, DIALOG_BLOCKING_EVALUATE_TIMEOUT_MS)
    timeout.unref()
  })

  try {
    return await Promise.race([operation(), timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function performClick(
  runtimePage: RuntimePage,
  frame: FrameLike,
  frameId: string | undefined,
  target: PointerTarget,
  timeout: number,
  noWaitAfter: boolean,
  deps: ActionDeps
): Promise<void> {
  const options = noWaitAfter
    ? { timeout, noWaitAfter: true }
    : { timeout }
  if (target.kind === "ref") {
    const handle = await deps.snapshotRegistry.resolveRef(
      runtimePage.id,
      target.ref,
      frameId
    )
    await withRefActionError(target.ref, () =>
      performActionOrCaptureDialog(runtimePage, () =>
        handle.click(options), deps
      )
    )
  } else if (target.kind === "selector") {
    await withSelectorError(() =>
      performActionOrCaptureDialog(runtimePage, () =>
        frame.locator(target.selector).click(options), deps
      )
    )
  } else {
    await performActionOrCaptureDialog(runtimePage, () =>
      runtimePage.page.mouse.click(target.x, target.y), deps
    )
  }
}

export async function performDoubleClick(
  runtimePage: RuntimePage,
  frame: FrameLike,
  frameId: string | undefined,
  target: PointerTarget,
  timeout: number,
  noWaitAfter: boolean,
  deps: ActionDeps
): Promise<void> {
  const options = noWaitAfter
    ? { timeout, noWaitAfter: true }
    : { timeout }
  if (target.kind === "ref") {
    const handle = await deps.snapshotRegistry.resolveRef(
      runtimePage.id,
      target.ref,
      frameId
    )
    await withRefActionError(target.ref, () =>
      performActionOrCaptureDialog(runtimePage, () =>
        handle.dblclick(options), deps
      )
    )
  } else if (target.kind === "selector") {
    await withSelectorError(() =>
      performActionOrCaptureDialog(runtimePage, () =>
        frame.locator(target.selector).dblclick(options), deps
      )
    )
  } else {
    await performActionOrCaptureDialog(runtimePage, () =>
      runtimePage.page.mouse.dblclick(target.x, target.y), deps
    )
  }
}

export async function performHover(
  runtimePage: RuntimePage,
  frame: FrameLike,
  frameId: string | undefined,
  target: PointerTarget,
  timeout: number,
  deps: ActionDeps
): Promise<void> {
  if (target.kind === "ref") {
    const handle = await deps.snapshotRegistry.resolveRef(
      runtimePage.id,
      target.ref,
      frameId
    )
    await withRefActionError(target.ref, () => handle.hover({ timeout }))
  } else if (target.kind === "selector") {
    await withSelectorError(() =>
      frame.locator(target.selector).hover({ timeout })
    )
  } else {
    await runtimePage.page.mouse.move(target.x, target.y)
  }
}

export async function performPress(
  runtimePage: RuntimePage,
  frame: FrameLike,
  frameId: string | undefined,
  target: ElementTarget,
  key: string,
  timeout: number,
  noWaitAfter: boolean,
  deps: ActionDeps
): Promise<void> {
  const options = noWaitAfter
    ? { timeout, noWaitAfter: true }
    : { timeout }
  if (target.kind === "ref") {
    const handle = await deps.snapshotRegistry.resolveRef(
      runtimePage.id,
      target.ref,
      frameId
    )
    await withRefActionError(target.ref, () =>
      performActionOrCaptureDialog(runtimePage, () =>
        handle.press(key, options), deps
      )
    )
  } else {
    await withSelectorError(() =>
      performActionOrCaptureDialog(runtimePage, () =>
        frame.locator(target.selector).press(key, options), deps
      )
    )
  }
}

export async function performTriggerAction(
  runtimePage: RuntimePage,
  action: ExpectNavigationAction,
  timeout: number,
  mode: "navigation" | "popup" | "download" | "upload",
  deps: ActionDeps
): Promise<void> {
  const frame = await deps.frameRegistry.resolve(runtimePage, action.frameId)
  if (action.type === "click") {
    await performClick(
      runtimePage,
      frame,
      action.frameId,
      resolvePointerTarget(action, "click"),
      timeout,
      true,
      deps
    )
    return
  }

  if (action.type === "double_click") {
    await performDoubleClick(
      runtimePage,
      frame,
      action.frameId,
      resolvePointerTarget(action, "double click"),
      timeout,
      true,
      deps
    )
    return
  }

  if (action.type === "press") {
    await performPress(
      runtimePage,
      frame,
      action.frameId,
      resolveElementTarget(action, "press"),
      action.key as string,
      timeout,
      true,
      deps
    )
    return
  }

  throw new BrowserToolError("invalid_request", `Unsupported ${mode} action.`)
}

export async function pointForTarget(
  runtimePage: RuntimePage,
  frame: FrameLike,
  target: PointerTarget,
  timeout: number,
  deps: ActionDeps
): Promise<Point> {
  if (target.kind === "point") return { x: target.x, y: target.y }

  if (target.kind === "ref") {
    const handle = await deps.snapshotRegistry.resolveRef(runtimePage.id, target.ref)
    const box = await withRefActionError(target.ref, () =>
      handle.boundingBox()
    )
    if (!box) {
      throw new BrowserToolError(
        "element_ref_not_found",
        `Element ref has no visible bounding box: ${target.ref}. Take a new browser_snapshot for this tab.`
      )
    }
    return centerOfBox(box)
  }

  return withSelectorError(async () => {
    const box = await frame
      .locator(target.selector)
      .boundingBox({ timeout })
    if (!box) {
      throw new BrowserToolError(
        "selector_not_found",
        `Selector has no visible bounding box: ${target.selector}`
      )
    }
    return centerOfBox(box)
  })
}
