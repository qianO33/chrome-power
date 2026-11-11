import type {
  BrowserDevicePresetName,
  BrowserPermissionName,
  ContextEmulationOverrides,
  DeviceData,
  EmulationData,
  EmulationData as EmulationDataType,
  EnvironmentData,
  GeolocationData,
  MediaData,
  MediaOverrides,
  OfflineData,
  PermissionGrantData,
  ViewportData,
  ViewportPresetName,
  ViewportSize,
} from "./contracts.js"
import {
  DEVICE_PRESETS,
  cloneEmulationOverrides,
  clearDeviceEmulationFields,
  devicePresetList,
  isSupportedDevicePreset,
} from "./device-presets.js"
import { BrowserToolError } from "./errors.js"
import {
  hasValue,
  isSupportedBrowserPermission,
} from "./validation-utils.js"
import {
  SUPPORTED_BROWSER_PERMISSIONS,
  SUPPORTED_EMULATION_FIELDS,
  SUPPORTED_MEDIA_FIELDS,
} from "./contracts.js"

export type ViewportOptions = {
  tabId?: string
  width?: number
  height?: number
  preset?: string
}

export type DeviceOptions = {
  preset?: string
  clear?: boolean
  confirmed?: boolean
}

export type MediaOptions = {
  tabId?: string
  colorScheme?: MediaOverrides["colorScheme"]
  reducedMotion?: MediaOverrides["reducedMotion"]
  forcedColors?: MediaOverrides["forcedColors"]
  clear?: boolean
}

export type GeolocationOptions = {
  latitude?: number
  longitude?: number
  accuracy?: number
  clear?: boolean
}

export type PermissionsOptions = {
  permissions?: string[]
  origin?: string
  clear?: boolean
}

export type EmulationOptions = ContextEmulationOverrides & {
  clear?: boolean
  confirmed?: boolean
}

const MAX_VIEWPORT_DIMENSION = 10_000
const MAX_USER_AGENT_LENGTH = 512
const MAX_DEVICE_SCALE_FACTOR = 10
const MAX_PERMISSION_GRANTS = 100

export const VIEWPORT_PRESETS: Record<ViewportPresetName, ViewportSize> = {
  desktop: { width: 1280, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
}

function validateViewportDimension(value: number, field: "width" | "height") {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_VIEWPORT_DIMENSION) {
    throw new BrowserToolError(
      "invalid_request",
      `Viewport ${field} must be an integer between 1 and ${MAX_VIEWPORT_DIMENSION}.`
    )
  }
}

export function resolveViewportSize(options: ViewportOptions): ViewportSize {
  const hasWidth = options.width != null
  const hasHeight = options.height != null
  const hasPreset = hasValue(options.preset)

  if (hasPreset && (hasWidth || hasHeight)) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide either preset or explicit width and height, not both."
    )
  }

  if (hasPreset) {
    const preset = options.preset as ViewportPresetName
    const size = VIEWPORT_PRESETS[preset]
    if (!size) {
      throw new BrowserToolError(
        "invalid_request",
        `Unknown viewport preset: ${options.preset}`
      )
    }
    return size
  }

  if (hasWidth !== hasHeight) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide both width and height for explicit viewport sizing."
    )
  }

  if (!hasWidth || !hasHeight) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide a viewport preset or explicit width and height."
    )
  }

  const size = {
    width: options.width as number,
    height: options.height as number,
  }
  validateViewportDimension(size.width, "width")
  validateViewportDimension(size.height, "height")
  return size
}

export function resolveDeviceState(
  currentOverrides: ContextEmulationOverrides,
  options: DeviceOptions
): {
  activeDevicePreset?: BrowserDevicePresetName
  launchViewportOverride?: ViewportSize
  emulationOverrides: ContextEmulationOverrides
} {
  if (options.clear === true) {
    if (hasValue(options.preset)) {
      throw new BrowserToolError(
        "invalid_request",
        "Device clear mode cannot include a preset."
      )
    }
    const emulationOverrides = cloneEmulationOverrides(currentOverrides)
    clearDeviceEmulationFields(emulationOverrides)
    return {
      activeDevicePreset: undefined,
      launchViewportOverride: undefined,
      emulationOverrides,
    }
  }

  if (!hasValue(options.preset)) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide a device preset, or clear: true."
    )
  }

  const presetName = options.preset
  if (!isSupportedDevicePreset(presetName)) {
    throw new BrowserToolError(
      "invalid_request",
      `Unknown device preset: ${options.preset}`
    )
  }

  const preset = DEVICE_PRESETS[presetName]
  const emulationOverrides = cloneEmulationOverrides(currentOverrides)
  emulationOverrides.userAgent = preset.emulation.userAgent
  emulationOverrides.deviceScaleFactor = preset.emulation.deviceScaleFactor
  emulationOverrides.hasTouch = preset.emulation.hasTouch
  emulationOverrides.isMobile = preset.emulation.isMobile

  return {
    activeDevicePreset: preset.name,
    launchViewportOverride: { ...preset.viewport },
    emulationOverrides,
  }
}

function resolveUserAgent(value: string | undefined) {
  if (typeof value !== "string") {
    throw new BrowserToolError("invalid_request", "userAgent must be a string.")
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_USER_AGENT_LENGTH) {
    throw new BrowserToolError(
      "invalid_request",
      `userAgent must be a non-empty string up to ${MAX_USER_AGENT_LENGTH} characters.`
    )
  }
  return trimmed
}

function resolveLocale(value: string | undefined) {
  if (typeof value !== "string") {
    throw new BrowserToolError("invalid_request", "locale must be a string.")
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new BrowserToolError(
      "invalid_request",
      "locale must be a non-empty string."
    )
  }

  try {
    const [locale] = Intl.getCanonicalLocales(trimmed)
    if (!locale) throw new Error("empty locale")
    return locale
  } catch {
    throw new BrowserToolError(
      "invalid_request",
      `Invalid locale: ${value}`
    )
  }
}

function resolveTimezoneId(value: string | undefined) {
  if (typeof value !== "string") {
    throw new BrowserToolError("invalid_request", "timezoneId must be a string.")
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new BrowserToolError(
      "invalid_request",
      "timezoneId must be a non-empty string."
    )
  }

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: trimmed,
    }).resolvedOptions().timeZone
  } catch {
    throw new BrowserToolError(
      "invalid_request",
      `Invalid timezoneId: ${value}`
    )
  }
}

function resolveDeviceScaleFactor(value: number | undefined) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_DEVICE_SCALE_FACTOR
  ) {
    throw new BrowserToolError(
      "invalid_request",
      `deviceScaleFactor must be a finite number greater than 0 and no more than ${MAX_DEVICE_SCALE_FACTOR}.`
    )
  }
  return value
}

function resolveBooleanEmulationField(
  value: boolean | undefined,
  field: "hasTouch" | "isMobile"
) {
  if (typeof value !== "boolean") {
    throw new BrowserToolError("invalid_request", `${field} must be a boolean.`)
  }
  return value
}

export function resolveEmulationOverrides(
  currentOverrides: ContextEmulationOverrides,
  options: EmulationOptions
): ContextEmulationOverrides {
  const fields = SUPPORTED_EMULATION_FIELDS.filter(
    (field) => options[field] !== undefined
  )

  if (options.clear === true) {
    if (fields.length > 0) {
      throw new BrowserToolError(
        "invalid_request",
        "Emulation clear mode cannot include emulation fields."
      )
    }
    return {}
  }

  if (fields.length === 0) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide at least one emulation field, or clear: true."
    )
  }

  const nextOverrides = cloneEmulationOverrides(currentOverrides)
  for (const field of fields) {
    switch (field) {
      case "userAgent":
        nextOverrides.userAgent = resolveUserAgent(options.userAgent)
        break
      case "locale":
        nextOverrides.locale = resolveLocale(options.locale)
        break
      case "timezoneId":
        nextOverrides.timezoneId = resolveTimezoneId(options.timezoneId)
        break
      case "deviceScaleFactor":
        nextOverrides.deviceScaleFactor = resolveDeviceScaleFactor(
          options.deviceScaleFactor
        )
        break
      case "hasTouch":
        nextOverrides.hasTouch = resolveBooleanEmulationField(
          options.hasTouch,
          "hasTouch"
        )
        break
      case "isMobile":
        nextOverrides.isMobile = resolveBooleanEmulationField(
          options.isMobile,
          "isMobile"
        )
        break
    }
  }

  return nextOverrides
}

export function resolveGeolocation(
  options: GeolocationOptions
): GeolocationData | null {
  if (options.clear === true) {
    if (
      options.latitude != null ||
      options.longitude != null ||
      options.accuracy != null
    ) {
      throw new BrowserToolError(
        "invalid_request",
        "Geolocation clear mode cannot include latitude, longitude, or accuracy."
      )
    }
    return null
  }

  if (options.latitude == null || options.longitude == null) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide latitude and longitude, or clear: true."
    )
  }

  if (
    !Number.isFinite(options.latitude) ||
    options.latitude < -90 ||
    options.latitude > 90
  ) {
    throw new BrowserToolError(
      "invalid_request",
      "Latitude must be a finite number between -90 and 90."
    )
  }

  if (
    !Number.isFinite(options.longitude) ||
    options.longitude < -180 ||
    options.longitude > 180
  ) {
    throw new BrowserToolError(
      "invalid_request",
      "Longitude must be a finite number between -180 and 180."
    )
  }

  if (
    options.accuracy != null &&
    (!Number.isFinite(options.accuracy) || options.accuracy < 0)
  ) {
    throw new BrowserToolError(
      "invalid_request",
      "Accuracy must be a finite non-negative number."
    )
  }

  return {
    latitude: options.latitude,
    longitude: options.longitude,
    accuracy: options.accuracy,
  }
}

export function resolvePermissions(
  permissions: string[] | undefined
): BrowserPermissionName[] {
  if (!permissions || permissions.length === 0) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide at least one permission, or clear: true."
    )
  }

  const resolved: BrowserPermissionName[] = []
  for (const permission of permissions) {
    if (!isSupportedBrowserPermission(permission)) {
      throw new BrowserToolError(
        "invalid_request",
        `Unsupported permission: ${permission}`
      )
    }
    if (!resolved.includes(permission)) {
      resolved.push(permission)
    }
  }

  return resolved
}

export function resolvePermissionOrigin(origin: string | undefined) {
  if (!hasValue(origin)) return undefined
  const trimmed = origin.trim()
  try {
    const parsed = new URL(trimmed)
    if (parsed.origin !== trimmed || parsed.origin === "null") {
      throw new Error("origin must not include path, query, or hash")
    }
    return parsed.origin
  } catch {
    throw new BrowserToolError(
      "invalid_request",
      "Permission origin must be a valid URL origin without path, query, or hash."
    )
  }
}

export function recordPermissionGrant(
  grants: PermissionGrantData[],
  grant: PermissionGrantData
): PermissionGrantData[] {
  const result = grants.map((g) => ({ ...g, permissions: [...g.permissions] }))
  const existing = result.find((entry) => entry.origin === grant.origin)
  if (!existing) {
    if (grant.origin != null) {
      const originEntries = result.filter((entry) => entry.origin != null)
      if (originEntries.length >= MAX_PERMISSION_GRANTS) {
        const oldestOriginIndex = result.findIndex(
          (entry) => entry.origin != null
        )
        if (oldestOriginIndex >= 0) {
          result.splice(oldestOriginIndex, 1)
        }
      }
    }
    result.push({
      permissions: [...grant.permissions],
      origin: grant.origin,
    })
    return result
  }

  existing.permissions = [
    ...new Set([...existing.permissions, ...grant.permissions]),
  ]
  return result
}

export function resolveMediaOverrides(
  currentOverrides: MediaOverrides | undefined,
  options: MediaOptions
): MediaOverrides {
  const fields = SUPPORTED_MEDIA_FIELDS.filter(
    (field) => options[field] !== undefined
  )
  if (options.clear === true) {
    if (fields.length > 0) {
      throw new BrowserToolError(
        "invalid_request",
        "Media clear mode cannot include media fields."
      )
    }
    return {}
  }
  if (fields.length === 0) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide at least one media field, or clear: true."
    )
  }
  return {
    ...(currentOverrides ?? {}),
    colorScheme: options.colorScheme ?? currentOverrides?.colorScheme,
    reducedMotion: options.reducedMotion ?? currentOverrides?.reducedMotion,
    forcedColors: options.forcedColors ?? currentOverrides?.forcedColors,
  }
}

export function buildViewportData(
  size: Pick<ViewportData, "width" | "height" | "mode">
): ViewportData {
  const matchedPreset = Object.entries(VIEWPORT_PRESETS).find(
    ([, presetSize]) =>
      presetSize.width === size.width && presetSize.height === size.height
  )?.[0] as ViewportPresetName | undefined

  return {
    width: size.width,
    height: size.height,
    mode: size.mode,
    preset: matchedPreset,
    presets: VIEWPORT_PRESETS,
  }
}

export function buildEnvironmentData(
  geolocationOverride: GeolocationData | undefined,
  permissionGrants: PermissionGrantData[]
): EnvironmentData {
  return {
    geolocation: geolocationOverride
      ? { ...geolocationOverride }
      : undefined,
    permissionGrants: permissionGrants.map((grant) => ({
      permissions: [...grant.permissions],
      origin: grant.origin,
    })),
    supportedPermissions: [...SUPPORTED_BROWSER_PERMISSIONS],
    deferred: {
      contextRelaunchRequired: [],
    },
  }
}

export function buildDeviceData(
  activeDevicePreset: BrowserDevicePresetName | undefined,
  contextLaunched: boolean,
  relaunched = false
): DeviceData {
  const activePreset = activeDevicePreset
    ? DEVICE_PRESETS[activeDevicePreset]
    : undefined

  return {
    presets: devicePresetList(),
    active: activePreset
      ? { name: activePreset.name, label: activePreset.label }
      : undefined,
    contextLaunched,
    appliedToCurrentContext: contextLaunched && activePreset != null,
    relaunchRequired: false,
    relaunched,
  }
}

export function buildEmulationData(
  overrides: ContextEmulationOverrides,
  contextLaunched: boolean,
  relaunched = false
): EmulationData {
  return {
    overrides: cloneEmulationOverrides(overrides),
    supported: [...SUPPORTED_EMULATION_FIELDS],
    contextLaunched,
    appliedToCurrentContext: contextLaunched,
    relaunchRequired: false,
    relaunched,
  }
}

export function buildOfflineData(
  offline: boolean,
  contextLaunched: boolean
): OfflineData {
  return {
    offline,
    contextLaunched,
    appliedToCurrentContext: contextLaunched,
  }
}

export function buildMediaData(
  overrides: MediaOverrides | undefined
): MediaData {
  return {
    overrides: { ...(overrides ?? {}) },
    supported: [...SUPPORTED_MEDIA_FIELDS],
  }
}
