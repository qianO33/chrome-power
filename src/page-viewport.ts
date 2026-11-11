import type { Page } from "playwright"

import { evaluateWithDialogGuard, type ActionDeps } from "./action-execution.js"
import type { ViewportData } from "./contracts.js"
import { BrowserToolError } from "./errors.js"

/** Resolve CSS dimensions without inventing a viewport for a native window. */
export async function readPageViewport(
  runtimePage: { id: string; page: Page },
  deps: Pick<ActionDeps, "dialogs">
): Promise<Pick<ViewportData, "width" | "height" | "mode">> {
  const fixed = runtimePage.page.viewportSize()
  const size = fixed ?? await evaluateWithDialogGuard(
    runtimePage,
    "Browser viewport measurement",
    () => runtimePage.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })),
    deps
  )
  if (
    !Number.isFinite(size.width) || !Number.isFinite(size.height) ||
    size.width <= 0 || size.height <= 0
  ) {
    throw new BrowserToolError("operation_failed", "Unable to measure a positive browser viewport.")
  }
  return { width: size.width, height: size.height, mode: fixed ? "fixed" : "window" }
}
