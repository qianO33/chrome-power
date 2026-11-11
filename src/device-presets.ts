import { devices } from "playwright"

import {
  SUPPORTED_DEVICE_PRESETS,
  SUPPORTED_EMULATION_FIELDS,
  type BrowserDevicePresetData,
  type BrowserDevicePresetName,
  type ContextEmulationOverrides,
  type ViewportSize,
} from "./contracts.js"

type PlaywrightDeviceDescriptor = {
  userAgent: string
  viewport: ViewportSize
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  defaultBrowserType?: string
}

const DEVICE_PRESET_DESCRIPTORS: Record<
  BrowserDevicePresetName,
  { label: string; descriptorName: string }
> = {
  "desktop-chrome": {
    label: "Desktop Chrome",
    descriptorName: "Desktop Chrome",
  },
  "desktop-chrome-hidpi": {
    label: "Desktop Chrome HiDPI",
    descriptorName: "Desktop Chrome HiDPI",
  },
  "pixel-5": {
    label: "Pixel 5",
    descriptorName: "Pixel 5",
  },
  "pixel-5-landscape": {
    label: "Pixel 5 landscape",
    descriptorName: "Pixel 5 landscape",
  },
  "galaxy-tab-s9": {
    label: "Galaxy Tab S9",
    descriptorName: "Galaxy Tab S9",
  },
  "galaxy-tab-s9-landscape": {
    label: "Galaxy Tab S9 landscape",
    descriptorName: "Galaxy Tab S9 landscape",
  },
}

export const DEVICE_PRESETS: Record<BrowserDevicePresetName, BrowserDevicePresetData> =
  Object.fromEntries(
    SUPPORTED_DEVICE_PRESETS.map((name) => [
      name,
      buildDevicePreset(name),
    ])
  ) as Record<BrowserDevicePresetName, BrowserDevicePresetData>

function buildDevicePreset(
  name: BrowserDevicePresetName
): BrowserDevicePresetData {
  const { label, descriptorName } = DEVICE_PRESET_DESCRIPTORS[name]
  const descriptor = (
    devices as Record<string, PlaywrightDeviceDescriptor | undefined>
  )[descriptorName]
  if (!descriptor) {
    throw new Error(`Missing Playwright device descriptor: ${descriptorName}`)
  }
  if (descriptor.defaultBrowserType !== "chromium") {
    throw new Error(
      `Device preset ${name} must use a Chromium Playwright descriptor.`
    )
  }

  return {
    name,
    label,
    source: "playwright",
    browserType: "chromium",
    viewport: { ...descriptor.viewport },
    emulation: {
      userAgent: descriptor.userAgent,
      deviceScaleFactor: descriptor.deviceScaleFactor,
      hasTouch: descriptor.hasTouch,
      isMobile: descriptor.isMobile,
    },
  }
}

export function devicePresetList(): BrowserDevicePresetData[] {
  return SUPPORTED_DEVICE_PRESETS.map((name) =>
    cloneDevicePreset(DEVICE_PRESETS[name])
  )
}

export function cloneDevicePreset(
  preset: BrowserDevicePresetData
): BrowserDevicePresetData {
  return {
    ...preset,
    viewport: { ...preset.viewport },
    emulation: { ...preset.emulation },
  }
}

export function cloneEmulationOverrides(
  overrides: ContextEmulationOverrides
): ContextEmulationOverrides {
  return { ...overrides }
}

export function clearDeviceEmulationFields(overrides: ContextEmulationOverrides) {
  delete overrides.userAgent
  delete overrides.deviceScaleFactor
  delete overrides.hasTouch
  delete overrides.isMobile
}

export function viewportSizesEqual(
  left: ViewportSize | undefined,
  right: ViewportSize | undefined
) {
  return left?.width === right?.width && left?.height === right?.height
}

export function emulationOverridesEqual(
  left: ContextEmulationOverrides,
  right: ContextEmulationOverrides
) {
  return SUPPORTED_EMULATION_FIELDS.every((field) => left[field] === right[field])
}

export function isSupportedDevicePreset(
  value: string
): value is BrowserDevicePresetName {
  return SUPPORTED_DEVICE_PRESETS.includes(value as BrowserDevicePresetName)
}
