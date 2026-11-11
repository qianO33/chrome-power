import { basename, extname, resolve } from "node:path"
import { randomUUID } from "node:crypto"

import type { Dialog } from "playwright"

import {
  SUPPORTED_ARTIFACT_TYPES,
  SUPPORTED_BROWSER_PERMISSIONS,
  type ArtifactType,
  type BrowserPermissionName,
  type DialogInfo,
} from "./contracts.js"
import { BrowserToolError } from "./errors.js"

type Point = { x: number; y: number }

const MAX_DIAGNOSTIC_URL_LENGTH = 4_000

export function hasValue(value: string | null | undefined): value is string {
  return value != null && value.length > 0
}

export function isSupportedArtifactType(type: string): type is ArtifactType {
  return SUPPORTED_ARTIFACT_TYPES.includes(type as ArtifactType)
}

export function isSupportedBrowserPermission(
  permission: string
): permission is BrowserPermissionName {
  return SUPPORTED_BROWSER_PERMISSIONS.includes(
    permission as BrowserPermissionName
  )
}

export function sanitizeDownloadFilename(value: string) {
  const baseName = basename(value.replace(/\\/g, "/"))
  const sanitized = baseName
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"\/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "")
    .trim()
  return sanitized.length > 0 ? sanitized : undefined
}

export function uniqueDownloadFilename(filename: string) {
  return `${Date.now()}-${randomUUID().slice(0, 8)}-${filename}`
}

export function urlMatcher(pattern: string) {
  if (!pattern.includes("*")) return new RegExp(`^${escapeRegExp(pattern)}$`)
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function dialogInfo(dialog: Dialog): DialogInfo {
  const defaultValue = dialog.defaultValue()
  return {
    type: dialog.type() as DialogInfo["type"],
    message: dialog.message(),
    defaultValue: defaultValue.length > 0 ? defaultValue : undefined,
  }
}

export function pendingDialogError(operationName: string) {
  return new BrowserToolError(
    "operation_failed",
    `${operationName} cannot run while this tab has an unhandled JavaScript dialog; call browser_dialog with action \"handle\" first.`
  )
}

export function centerOfBox(box: {
  x: number
  y: number
  width: number
  height: number
}): Point {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  }
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function trimStart<T>(values: T[], limit: number) {
  if (values.length > limit) {
    values.splice(0, values.length - limit)
  }
}

export function truncate(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}[truncated ${value.length - limit} chars]`
    : value
}

export function boundedDiagnosticUrl(value: string) {
  return truncate(value, MAX_DIAGNOSTIC_URL_LENGTH)
}

export function resolveScreenshotPath(requestedPath: string) {
  const resolvedPath = resolve(requestedPath)
  const extension = extname(resolvedPath)
  if (extension && extension.toLowerCase() !== ".png") {
    throw new BrowserToolError(
      "invalid_request",
      "Screenshot path must use a .png extension."
    )
  }
  return extension ? resolvedPath : `${resolvedPath}.png`
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function isClosedContextError(error: unknown) {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes("target page, context or browser has been closed") ||
    message.includes("target closed") ||
    message.includes("browser has been closed") ||
    message.includes("browser context has been closed") ||
    message.includes("context closed")
  )
}

export function isNotFoundError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

export function isDetachedRefError(error: unknown) {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes("not attached") ||
    message.includes("target closed") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context")
  )
}
