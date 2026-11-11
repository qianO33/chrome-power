import type { ScreenshotClip, ViewportSize } from "./contracts.js"
import { BrowserToolError } from "./errors.js"

export type ScreenshotOptions = {
  tabId?: string
  path?: string
  base64?: boolean
  fullPage?: boolean
  clip?: ScreenshotClip
}

export function resolveScreenshotClip(
  clip: ScreenshotClip | undefined,
  viewport: ViewportSize | null,
  fullPage: boolean
) {
  if (!clip) return undefined
  if (fullPage) {
    throw new BrowserToolError(
      "invalid_request",
      "clip cannot be combined with fullPage: true."
    )
  }
  if (!viewport) {
    throw new BrowserToolError(
      "invalid_request",
      "A viewport is required for screenshot clipping."
    )
  }
  const { x, y, width, height } = clip
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > viewport.width ||
    y + height > viewport.height
  ) {
    throw new BrowserToolError(
      "invalid_request",
      `clip must be finite, positive, and fully inside the ${viewport.width}x${viewport.height} viewport.`
    )
  }
  return { x, y, width, height }
}

export function validateViewportPoint(
  x: number,
  y: number,
  viewport: ViewportSize | null
) {
  if (
    !viewport ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= viewport.width ||
    y >= viewport.height
  ) {
    throw new BrowserToolError(
      "invalid_request",
      viewport
        ? `Point must be finite and inside the ${viewport.width}x${viewport.height} viewport.`
        : "A viewport is required for point inspection."
    )
  }
}
