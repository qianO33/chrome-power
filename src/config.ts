import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import {
  namespaceArtifactDir,
  namespaceProfileDir,
  parseRuntimeNamespace,
} from "./runtime-namespace.js"
import type { ResourceProtectionLimits } from "./contracts.js"
import {
  DEFAULT_COOKIE_MAX_TTL_SECONDS,
  MAX_COOKIE_MAX_TTL_SECONDS,
  parseCookieAllowedOrigins,
} from "./contracts.js"
import {
  loadBrowserTargetsFile,
  type BrowserTargetsFile,
} from "./browser-targets.js"

export type BrowserCallLimitConfig = Omit<
  ResourceProtectionLimits,
  "queueWaitTimeoutMs"
>

export type RuntimeConfig = {
  headless: boolean
  profileDir: string
  screenshotDir: string
  screenshotInlineMaxBytes: number
  downloadDir: string
  slowMoMs: number
  namespace?: string
  namespaceMode: "shared" | "isolated"
  ownerSocket?: string
  ownerPort?: number
  ownerHost?: "127.0.0.1" | "::1"
  cookieAllowedOrigins: string[]
  cookieMaxTtlSeconds: number
  browserCallLimits: BrowserCallLimitConfig
  /** Opt-in multi-browser target definitions. Absent means legacy launch mode. */
  browserTargets?: BrowserTargetsFile
  targetsFile?: string
  targetConfigFingerprint?: string
}

export type RuntimeConfigOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export const DEFAULT_SCREENSHOT_INLINE_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_CONCURRENT_CALLS = 4
export const DEFAULT_MAX_QUEUED_CALLS = 32
export const DEFAULT_MAX_DIAGNOSTIC_WAITS = 2

const MAX_CONFIGURED_CONCURRENT_CALLS = 64
const MAX_CONFIGURED_QUEUED_CALLS = 1_024

function envFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const value = env[name]
  if (value == null || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function envBoundedNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const value = env[name]
  if (value == null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid ${name}: expected a finite number from ${minimum} to ${maximum}.`
    )
  }
  return parsed
}

function envNonnegativeInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
) {
  const value = env[name]
  if (value == null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid ${name}: expected a non-negative integer.`
    )
  }
  return parsed
}

function envIntegerInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const value = env[name]
  if (value == null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid ${name}: expected an integer from ${minimum} to ${maximum}.`
    )
  }
  return parsed
}

export function loadConfig(options: RuntimeConfigOptions = {}): RuntimeConfig {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const namespace = parseRuntimeNamespace(env.CHROME_POWER_NAMESPACE)
  if (
    namespace &&
    [
      "CHROME_POWER_OWNER_SOCKET",
      "CHROME_POWER_OWNER_PORT",
      "CHROME_POWER_OWNER_HOST",
    ].some((name) => env[name] != null && env[name] !== "")
  ) {
    throw new Error(
      "CHROME_POWER_NAMESPACE cannot be combined with CHROME_POWER_OWNER_SOCKET, CHROME_POWER_OWNER_PORT, or CHROME_POWER_OWNER_HOST."
    )
  }
  const baseProfileDir = resolve(
    env.CHROME_POWER_PROFILE_DIR ?? resolve(cwd, ".chrome-power/profile")
  )
  const baseScreenshotDir = resolve(
    env.CHROME_POWER_SCREENSHOT_DIR ?? resolve(cwd, "artifacts/screenshots")
  )
  const baseDownloadDir = resolve(
    env.CHROME_POWER_DOWNLOAD_DIR ?? resolve(cwd, "artifacts/downloads")
  )
  const ownerPort = parseOwnerPort(env.CHROME_POWER_OWNER_PORT)
  const ownerHost = ownerPort
    ? parseOwnerHost(env.CHROME_POWER_OWNER_HOST)
    : undefined
  const cookieAllowedOrigins = parseCookieAllowedOrigins(
    env.CHROME_POWER_COOKIE_ALLOWED_ORIGINS
  )
  const cookieMaxTtlSeconds = envIntegerInRange(
    env,
    "CHROME_POWER_COOKIE_MAX_TTL_SECONDS",
    DEFAULT_COOKIE_MAX_TTL_SECONDS,
    1,
    MAX_COOKIE_MAX_TTL_SECONDS
  )
  const targetsFileValue = env.CHROME_POWER_TARGETS_FILE
  const browserTargets =
    targetsFileValue == null || targetsFileValue.trim() === ""
      ? undefined
      : loadBrowserTargetsFile(resolve(cwd, targetsFileValue))
  const config: RuntimeConfig = {
    headless: envFlag(env, "CHROME_POWER_HEADLESS", false),
    profileDir: namespace
      ? namespaceProfileDir(baseProfileDir, namespace)
      : baseProfileDir,
    screenshotDir: namespace
      ? namespaceArtifactDir(baseScreenshotDir, namespace)
      : baseScreenshotDir,
    screenshotInlineMaxBytes: envNonnegativeInteger(
      env,
      "CHROME_POWER_SCREENSHOT_INLINE_MAX_BYTES",
      DEFAULT_SCREENSHOT_INLINE_MAX_BYTES
    ),
    downloadDir: namespace
      ? namespaceArtifactDir(baseDownloadDir, namespace)
      : baseDownloadDir,
    slowMoMs: envBoundedNumber(
      env,
      "CHROME_POWER_SLOW_MO",
      0,
      0,
      10_000
    ),
    namespace,
    namespaceMode: namespace ? "isolated" : "shared",
    ownerSocket:
      env.CHROME_POWER_OWNER_SOCKET == null ||
      env.CHROME_POWER_OWNER_SOCKET === ""
        ? undefined
        : resolve(cwd, env.CHROME_POWER_OWNER_SOCKET),
    ownerPort,
    ownerHost,
    cookieAllowedOrigins,
    cookieMaxTtlSeconds,
    browserCallLimits: {
      maxConcurrentCalls: envIntegerInRange(
        env,
        "CHROME_POWER_MAX_CONCURRENT_CALLS",
        DEFAULT_MAX_CONCURRENT_CALLS,
        1,
        MAX_CONFIGURED_CONCURRENT_CALLS
      ),
      maxQueuedCalls: envIntegerInRange(
        env,
        "CHROME_POWER_MAX_QUEUED_CALLS",
        DEFAULT_MAX_QUEUED_CALLS,
        0,
        MAX_CONFIGURED_QUEUED_CALLS
      ),
      maxDiagnosticWaits: envIntegerInRange(
        env,
        "CHROME_POWER_MAX_DIAGNOSTIC_WAITS",
        DEFAULT_MAX_DIAGNOSTIC_WAITS,
        1,
        MAX_CONFIGURED_CONCURRENT_CALLS
      ),
    },
  }
  if (!browserTargets) return config
  return {
    ...config,
    browserTargets,
    targetsFile: browserTargets.filePath,
    targetConfigFingerprint: browserTargets.fingerprint,
  }
}

function parseOwnerPort(value: string | undefined) {
  if (value == null || value === "") return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(
      "Invalid CHROME_POWER_OWNER_PORT: expected an integer from 1 to 65535."
    )
  }
  return parsed
}

function parseOwnerHost(value: string | undefined): "127.0.0.1" | "::1" {
  const host = value ?? "127.0.0.1"
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      "Invalid CHROME_POWER_OWNER_HOST: expected 127.0.0.1 or ::1."
    )
  }
  return host
}

export async function ensureRuntimeDirs(config: RuntimeConfig) {
  await mkdir(config.profileDir, { recursive: true })
  await mkdir(config.screenshotDir, { recursive: true })
  await mkdir(config.downloadDir, { recursive: true })
}
