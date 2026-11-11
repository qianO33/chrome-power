import { z } from "zod"

import {
  COOKIE_ACTIONS,
  COOKIE_MODES,
  COOKIE_SAME_SITE_VALUES,
  DEFAULT_COOKIE_MAX_TTL_SECONDS,
  MAX_COOKIE_MAX_TTL_SECONDS,
  type CookieInput,
  type CookieOperationInput,
  type CookieSameSite,
} from "./contracts.js"

export { DEFAULT_COOKIE_MAX_TTL_SECONDS, MAX_COOKIE_MAX_TTL_SECONDS }

export const MAX_COOKIE_INPUT_COUNT = 100
export const MAX_COOKIE_NAME_LENGTH = 256
export const MAX_COOKIE_VALUE_LENGTH = 4_096
export const MAX_COOKIE_HEADER_LENGTH = 128 * 1024
export const MAX_COOKIE_URL_LENGTH = 4_096
export const MAX_COOKIE_DOMAIN_LENGTH = 255
export const MAX_COOKIE_PATH_LENGTH = 4_096

const COOKIE_RECORD_FIELDS = new Set([
  "name",
  "value",
  "url",
  "domain",
  "path",
  "expires",
  "httpOnly",
  "secure",
  "sameSite",
])
const COOKIE_OPERATION_FIELDS = new Set([
  "action",
  "targetId",
  "tabId",
  "url",
  "cookieHeader",
  "cookies",
  "mode",
  "persist",
  "ttlSeconds",
  "reload",
])

const cookieSameSiteSchema = z.enum(COOKIE_SAME_SITE_VALUES)

export const cookieRecordSchema = z
  .object({
    name: z.string().min(1).max(MAX_COOKIE_NAME_LENGTH),
    value: z.string().max(MAX_COOKIE_VALUE_LENGTH),
    url: z.string().min(1).max(MAX_COOKIE_URL_LENGTH).optional(),
    domain: z.string().min(1).max(MAX_COOKIE_DOMAIN_LENGTH).optional(),
    path: z.string().min(1).max(MAX_COOKIE_PATH_LENGTH).optional(),
    expires: z.number().finite().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: cookieSameSiteSchema.optional(),
  })
  .strict()

export const cookieInputSchema = z
  .object({
    action: z.enum(COOKIE_ACTIONS),
    targetId: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    tabId: z.string().min(1).optional(),
    url: z.string().min(1).max(MAX_COOKIE_URL_LENGTH).optional(),
    cookieHeader: z.string().min(1).max(MAX_COOKIE_HEADER_LENGTH).optional(),
    cookies: z.array(cookieRecordSchema).min(1).max(MAX_COOKIE_INPUT_COUNT).optional(),
    mode: z.enum(COOKIE_MODES).optional(),
    persist: z.boolean().optional(),
    ttlSeconds: z.number().int().positive().optional(),
    reload: z.boolean().optional(),
  })
  .strict()

export type CookieTarget = {
  origin: string
  scheme: "http" | "https"
  hostname: string
  pathname: string
  effectivePort: number
  displayPort?: number
  loopback: boolean
}

export type NormalizedCookie = {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: CookieSameSite
}

export type NormalizedCookieBatch = {
  records: NormalizedCookie[]
  clearDomains: string[]
  inputFormat: "cookie_header" | "structured"
  inputCount: number
}

export class CookieValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CookieValidationError"
  }
}

export { parseCookieAllowedOrigins } from "./contracts.js"

export function resolveCookieTarget(
  pageUrl: string,
  requestedUrl: string | undefined,
  allowedOrigins: readonly string[]
): CookieTarget {
  const page = parseCookieUrl(pageUrl, "Cookie injection requires an HTTP(S) page.")
  if (requestedUrl != null) {
    const requested = parseCookieUrl(
      requestedUrl,
      "Cookie target URL must be an HTTP(S) URL."
    )
    if (requested.origin !== page.origin) {
      throw new CookieValidationError(
        "Cookie target URL must match the selected page origin."
      )
    }
  }

  if (!page.loopback && !allowedOrigins.includes(page.origin)) {
    throw new CookieValidationError(
      "Cookie injection is restricted to loopback targets or an exact configured allowlist origin."
    )
  }
  return page
}

export function normalizeCookieOperation(
  input: CookieOperationInput,
  target: CookieTarget,
  maxTtlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000)
): NormalizedCookieBatch {
  validateCookieOperationShape(input)
  if (input.action !== "inject") {
    throw new CookieValidationError("Cookie clear operations do not accept Cookie input.")
  }

  const persistent = input.persist === true
  const ttlSeconds = input.ttlSeconds
  if (persistent) {
    if (ttlSeconds == null) {
      throw new CookieValidationError(
        "Persistent Cookie injection requires ttlSeconds."
      )
    }
    if (ttlSeconds > maxTtlSeconds) {
      throw new CookieValidationError(
        "Cookie ttlSeconds exceeds the configured maximum."
      )
    }
  }

  if (input.cookieHeader != null) {
    const pairs = parseCookieHeader(input.cookieHeader)
    const records: NormalizedCookie[] = []
    const seen = new Set<string>()
    for (const pair of pairs) {
      const key = cookieScopeKey(pair.name, "host", target.hostname, "/")
      if (seen.has(key)) {
        throw new CookieValidationError(
          "Cookie input contains duplicate effective cookies."
        )
      }
      seen.add(key)
      const record: NormalizedCookie = {
        name: pair.name,
        value: pair.value,
        url: `${target.origin}/`,
      }
      if (persistent) {
        record.expires =
          nowSeconds + Math.min(ttlSeconds as number, maxTtlSeconds)
      }
      records.push(record)
    }
    return {
      records,
      clearDomains: [target.hostname],
      inputFormat: "cookie_header",
      inputCount: records.length,
    }
  }

  const source = input.cookies
  if (!source) {
    throw new CookieValidationError(
      "Cookie injection requires cookieHeader or cookies."
    )
  }

  const records: NormalizedCookie[] = []
  const clearDomains = new Set<string>([target.hostname])
  const seen = new Set<string>()
  for (const cookie of source) {
    const normalized = normalizeStructuredCookie(
      cookie,
      target,
      persistent,
      ttlSeconds,
      maxTtlSeconds,
      nowSeconds
    )
    const scope = normalizedScope(normalized, target)
    const key = cookieScopeKey(
      normalized.name,
      scope.kind,
      scope.domain,
      scope.path
    )
    if (seen.has(key)) {
      throw new CookieValidationError(
        "Cookie input contains duplicate effective cookies."
      )
    }
    seen.add(key)
    records.push(normalized)
    if (normalized.domain) clearDomains.add(normalized.domain)
  }

  return {
    records,
    clearDomains: [...clearDomains],
    inputFormat: "structured",
    inputCount: records.length,
  }
}

export function validateCookieOperationShape(input: CookieOperationInput) {
  if (!isRecord(input)) {
    throw new CookieValidationError("Invalid Cookie operation.")
  }
  if (![...Object.keys(input)].every((key) => COOKIE_OPERATION_FIELDS.has(key))) {
    throw new CookieValidationError("Cookie operation contains unsupported fields.")
  }
  if (input.action !== "inject" && input.action !== "clear_target") {
    throw new CookieValidationError("Invalid Cookie operation action.")
  }
  if (input.tabId != null && (!isString(input.tabId) || input.tabId.trim() === "")) {
    throw new CookieValidationError("Cookie tabId must be a non-empty string.")
  }
  if (input.url != null && (!isString(input.url) || input.url.trim() === "")) {
    throw new CookieValidationError("Cookie target URL must be a non-empty string.")
  }
  if (input.reload != null && typeof input.reload !== "boolean") {
    throw new CookieValidationError("Cookie reload must be a boolean.")
  }

  if (input.action === "clear_target") {
    if (
      input.cookieHeader != null ||
      input.cookies != null ||
      input.mode != null ||
      input.persist != null ||
      input.ttlSeconds != null
    ) {
      throw new CookieValidationError(
        "Cookie clear_target accepts only target and reload fields."
      )
    }
    return
  }

  const hasHeader = input.cookieHeader != null
  const hasRecords = input.cookies != null
  if (hasHeader === hasRecords) {
    throw new CookieValidationError(
      "Cookie injection requires exactly one input format."
    )
  }
  if (hasHeader && (!isString(input.cookieHeader) || input.cookieHeader.trim() === "")) {
    throw new CookieValidationError("Cookie header input must not be empty.")
  }
  if (hasRecords) {
    if (!Array.isArray(input.cookies) || input.cookies.length === 0) {
      throw new CookieValidationError("Structured Cookie input must not be empty.")
    }
    if (input.cookies.length > MAX_COOKIE_INPUT_COUNT) {
      throw new CookieValidationError("Structured Cookie input contains too many records.")
    }
  }
  if (input.mode != null && input.mode !== "merge" && input.mode !== "replace_target") {
    throw new CookieValidationError("Invalid Cookie write mode.")
  }
  if (input.persist === true) {
    if (!Number.isInteger(input.ttlSeconds) || (input.ttlSeconds as number) <= 0) {
      throw new CookieValidationError(
        "Persistent Cookie injection requires a positive integer ttlSeconds."
      )
    }
  } else if (input.ttlSeconds != null) {
    throw new CookieValidationError(
      "ttlSeconds is only valid when persist is true."
    )
  }
  if (input.persist != null && typeof input.persist !== "boolean") {
    throw new CookieValidationError("Cookie persist must be a boolean.")
  }
}

export function hasOtherLoopbackPort(
  pageUrls: readonly string[],
  target: CookieTarget
) {
  if (!target.loopback) return false
  return pageUrls.some((value) => {
    try {
      const candidate = parseCookieUrl(value, "")
      return (
        candidate.loopback &&
        candidate.hostname === target.hostname &&
        candidate.effectivePort !== target.effectivePort
      )
    } catch {
      return false
    }
  })
}

export function cookieTargetData(target: CookieTarget) {
  return {
    scheme: target.scheme,
    host: target.hostname,
    ...(target.displayPort == null ? {} : { port: target.displayPort }),
  }
}

export function cookieDomainClearFilters(domains: readonly string[]) {
  const filters = new Set<string>()
  for (const domain of domains) {
    const normalized = domain.toLowerCase()
    const bare = normalized.startsWith(".") ? normalized.slice(1) : normalized
    filters.add(normalized)
    filters.add(bare)
    if (!isIpAddress(bare)) filters.add(`.${bare}`)
  }
  return [...filters]
}

function normalizeStructuredCookie(
  cookie: CookieInput,
  target: CookieTarget,
  persistent: boolean,
  ttlSeconds: number | undefined,
  maxTtlSeconds: number,
  nowSeconds: number
): NormalizedCookie {
  if (!isRecord(cookie) || !hasOnlyCookieFields(cookie)) {
    throw new CookieValidationError("Structured Cookie input contains unsupported fields.")
  }
  if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
    throw new CookieValidationError("Structured Cookie name and value are required.")
  }
  for (const field of ["url", "domain", "path"] as const) {
    if (cookie[field] != null && typeof cookie[field] !== "string") {
      throw new CookieValidationError("Structured Cookie scope fields are invalid.")
    }
  }
  for (const field of ["httpOnly", "secure"] as const) {
    if (cookie[field] != null && typeof cookie[field] !== "boolean") {
      throw new CookieValidationError("Structured Cookie security fields are invalid.")
    }
  }
  if (cookie.expires != null && typeof cookie.expires !== "number") {
    throw new CookieValidationError("Cookie expires must be a valid timestamp.")
  }
  if (
    cookie.sameSite != null &&
    !COOKIE_SAME_SITE_VALUES.includes(cookie.sameSite as CookieSameSite)
  ) {
    throw new CookieValidationError("Structured Cookie sameSite is invalid.")
  }
  validateCookieName(cookie.name)
  validateCookieValue(cookie.value)
  if (cookie.url != null && cookie.domain != null) {
    throw new CookieValidationError(
      "A structured Cookie record cannot combine url and domain."
    )
  }

  let normalizedScope: { url?: URL; domain?: string; path: string }
  if (cookie.url != null) {
    const parsedUrl = parseHttpUrl(
      cookie.url,
      "Structured Cookie url must be an HTTP(S) URL."
    )
    const url = parseCookieUrl(
      cookie.url,
      "Structured Cookie url must be an HTTP(S) URL."
    )
    if (url.origin !== target.origin) {
      throw new CookieValidationError(
        "Structured Cookie url must match the selected page origin."
      )
    }
    if (cookie.path != null) {
      throw new CookieValidationError(
        "A structured Cookie record cannot combine url and path."
      )
    }
    const path = defaultCookiePath(url.pathname)
    if (!cookiePathMatchesTarget(path, target.pathname)) {
      throw new CookieValidationError(
        "Structured Cookie path is outside the selected page."
      )
    }
    normalizedScope = { url: parsedUrl, path }
  } else if (cookie.domain != null) {
    const domain = normalizeCookieDomain(cookie.domain, target.hostname)
    const path = cookie.path ?? "/"
    validateCookiePath(path, target.pathname)
    normalizedScope = { domain, path }
  } else if (cookie.path != null) {
    validateCookiePath(cookie.path, target.pathname)
    normalizedScope = { domain: target.hostname, path: cookie.path }
  } else {
    normalizedScope = { url: new URL(`${target.origin}/`), path: "/" }
  }

  const secure = cookie.secure
  if (secure === true && target.scheme !== "https" && !target.loopback) {
    throw new CookieValidationError(
      "Secure Cookies require an HTTPS target unless the target is loopback."
    )
  }
  if (cookie.sameSite === "None" && secure !== true) {
    throw new CookieValidationError(
      "SameSite=None Cookies require secure=true."
    )
  }

  const result: NormalizedCookie = {
    name: cookie.name,
    value: cookie.value,
    ...(normalizedScope.url
      ? { url: `${normalizedScope.url.origin}${normalizedScope.url.pathname}` }
      : { domain: normalizedScope.domain, path: normalizedScope.path }),
    ...(cookie.httpOnly == null ? {} : { httpOnly: cookie.httpOnly }),
    ...(secure == null ? {} : { secure }),
    ...(cookie.sameSite == null ? {} : { sameSite: cookie.sameSite }),
  }

  if (persistent) {
    const deadline = nowSeconds + Math.min(ttlSeconds as number, maxTtlSeconds)
    if (cookie.expires != null) {
      if (!Number.isFinite(cookie.expires) || cookie.expires <= nowSeconds) {
        throw new CookieValidationError(
          "Persistent Cookie expires must be later than the current time."
        )
      }
      result.expires = Math.min(cookie.expires, deadline)
    } else {
      result.expires = deadline
    }
  } else if (cookie.expires != null && (!Number.isFinite(cookie.expires) || cookie.expires < 0)) {
    throw new CookieValidationError("Cookie expires must be a valid timestamp.")
  }

  return result
}

function parseCookieHeader(header: string) {
  if (header.length > MAX_COOKIE_HEADER_LENGTH) {
    throw new CookieValidationError("Cookie header input is too large.")
  }
  let source = header.trim()
  if (/^cookie\s*:/i.test(source)) {
    source = source.replace(/^cookie\s*:/i, "").trim()
  }
  if (source === "") {
    throw new CookieValidationError("Cookie header input must not be empty.")
  }

  const pairs: Array<{ name: string; value: string }> = []
  for (const part of source.split(";")) {
    const pair = part.trim()
    if (pair === "") {
      throw new CookieValidationError("Cookie header input contains an invalid pair.")
    }
    const separator = pair.indexOf("=")
    if (separator <= 0) {
      throw new CookieValidationError("Cookie header input contains an invalid pair.")
    }
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    validateCookieName(name)
    validateCookieValue(value)
    pairs.push({ name, value })
  }
  if (pairs.length === 0 || pairs.length > MAX_COOKIE_INPUT_COUNT) {
    throw new CookieValidationError("Cookie header contains too many records.")
  }
  return pairs
}

function parseCookieUrl(value: string, message: string): CookieTarget {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CookieValidationError(message || "Cookie target URL is invalid.")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  ) {
    throw new CookieValidationError(message || "Cookie target URL is invalid.")
  }
  const scheme = url.protocol.slice(0, -1) as "http" | "https"
  const effectivePort = url.port
    ? Number(url.port)
    : scheme === "https"
      ? 443
      : 80
  const defaultPort = scheme === "https" ? 443 : 80
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return {
    origin: url.origin,
    scheme,
    hostname,
    pathname: url.pathname || "/",
    effectivePort,
    displayPort: url.port && effectivePort !== defaultPort ? effectivePort : undefined,
    loopback: isLoopbackHostname(hostname),
  }
}

function parseHttpUrl(value: string, message: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(message)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(message)
  }
  return url
}

function normalizeCookieDomain(value: string, targetHostname: string) {
  if (value !== value.trim() || value.includes("*") || /[\s/?#:@]/.test(value)) {
    throw new CookieValidationError("Structured Cookie domain is invalid.")
  }
  const leadingDot = value.startsWith(".")
  const bare = (leadingDot ? value.slice(1) : value).toLowerCase()
  if (
    bare === "" ||
    bare.length > MAX_COOKIE_DOMAIN_LENGTH ||
    bare.endsWith(".") ||
    !isCookieDomainSyntaxValid(bare)
  ) {
    throw new CookieValidationError("Structured Cookie domain is invalid.")
  }
  if (
    bare !== targetHostname &&
    !targetHostname.endsWith(`.${bare}`)
  ) {
    throw new CookieValidationError(
      "Structured Cookie domain is outside the selected page."
    )
  }
  return leadingDot ? `.${bare}` : bare
}

function validateCookiePath(path: string, targetPathname: string) {
  if (
    path !== path.trim() ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    hasControlCharacter(path) ||
    !cookiePathMatchesTarget(path, targetPathname)
  ) {
    throw new CookieValidationError("Structured Cookie path is invalid or outside the selected page.")
  }
}

function cookiePathMatchesTarget(cookiePath: string, targetPathname: string) {
  const targetPath = targetPathname || "/"
  if (cookiePath === "/") return true
  if (targetPath === cookiePath) return true
  return targetPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`)
}

function defaultCookiePath(pathname: string) {
  const path = pathname || "/"
  const slash = path.lastIndexOf("/")
  return slash <= 0 ? "/" : path.slice(0, slash)
}

function validateCookieName(name: string) {
  if (
    name.length === 0 ||
    name.length > MAX_COOKIE_NAME_LENGTH ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
  ) {
    throw new CookieValidationError("Cookie name is invalid.")
  }
}

function validateCookieValue(value: string) {
  if (value.length > MAX_COOKIE_VALUE_LENGTH || hasControlCharacter(value) || value.includes(";")) {
    throw new CookieValidationError("Cookie value is invalid.")
  }
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isCookieDomainSyntaxValid(value: string) {
  if (value === "localhost" || isIpAddress(value)) return true
  return value.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  )
}

function isIpAddress(value: string) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255)
  }
  return value.includes(":") && /^[0-9a-f:]+$/i.test(value)
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  )
}

function normalizedScope(cookie: NormalizedCookie, target: CookieTarget) {
  if (cookie.domain) {
    return {
      kind: "domain" as const,
      domain: cookie.domain,
      path: cookie.path ?? "/",
    }
  }
  const url = new URL(cookie.url as string)
  return {
    kind: "host" as const,
    domain: url.hostname.replace(/^\[|\]$/g, "").toLowerCase() || target.hostname,
    path: defaultCookiePath(url.pathname),
  }
}

function cookieScopeKey(
  name: string,
  kind: "host" | "domain",
  domain: string,
  path: string
) {
  return `${kind}|${domain.toLowerCase()}|${path}|${name}`
}

function hasOnlyCookieFields(value: Record<string, unknown>) {
  return Object.keys(value).every((key) => COOKIE_RECORD_FIELDS.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}
