import type { AssetKind, SnapshotElement } from "./contracts.js"

export type SensitiveFieldHints = {
  autocompleteValues: readonly string[]
  exactTokens: readonly string[]
  compactTerms: readonly string[]
}

export type SnapshotElementData = Omit<SnapshotElement, "ref">

export type PerformanceObserverProjection = {
  installed: boolean
  supportedEntryTypes: string[]
  lcp?: number
  cls?: number
  longTasks?: { count: number; total: number; max: number; blocking: number }
  interactionCount: number
  inp?: number
}

export type PerformancePageProjection = {
  observer?: PerformanceObserverProjection
  timeOrigin: number
  navigation?: Record<string, number | string>
  paints: Record<string, number>
  resources: Array<PerformanceAssetProjection>
}

export type DomAssetProjection = {
  identity: string
  url?: string
  scheme: string
  kind: AssetKind
  tagName?: string
  loading?: string
  renderedWidth?: number
  renderedHeight?: number
  intrinsicWidth?: number
  intrinsicHeight?: number
  viewBox?: { x: number; y: number; width: number; height: number }
  inline?: boolean
}

export type PerformanceAssetProjection = {
  identity: string
  url?: string
  scheme: string
  initiatorType: string
  startTime: number
  duration: number
  transferSize: number
  encodedBodySize: number
  decodedBodySize: number
}

export const SENSITIVE_FIELD_HINTS: SensitiveFieldHints = {
  autocompleteValues: [
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
  ],
  exactTokens: [
    "password",
    "passwd",
    "passcode",
    "auth",
    "token",
    "secret",
    "credential",
    "otp",
    "2fa",
    "cvv",
    "cvc",
    "csc",
    "card",
    "pan",
    "pin",
    "ssn",
    "iban",
  ],
  compactTerms: [
    "onetimecode",
    "authcode",
    "authenticationcode",
    "authorizationcode",
    "verificationcode",
    "securitycode",
    "cardnumber",
    "creditcardnumber",
    "debitcardnumber",
    "ccnumber",
    "ccnum",
    "cccsc",
    "cccvv",
    "cccvc",
    "cardcsc",
    "cardcvv",
    "cardcvc",
    "cardexpiration",
    "cardexpiry",
    "socialsecuritynumber",
    "accountnumber",
    "bankaccount",
    "bankaccountnumber",
    "routingnumber",
  ],
}

export const ACTIONABLE_ELEMENT_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable]",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='tab']",
].join(", ")

export const DEFAULT_MAX_ELEMENTS = 100
export const MAX_ELEMENTS = 500
export const MAX_ASSET_DOM_OCCURRENCES = 2_000
export const MAX_ASSET_BACKGROUND_ELEMENTS = 1_000

export function evaluateSnapshotSummary({
  limit,
  sensitiveFieldHints,
}: {
  limit: number
  sensitiveFieldHints: SensitiveFieldHints
}) {
  const normalizeHint = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const isSensitiveField = (target: Element) => {
    const inputType =
      target instanceof HTMLInputElement ? target.type.toLowerCase() : ""
    if (inputType === "password") return true
    const autocomplete =
      target.getAttribute("autocomplete")?.trim().toLowerCase() ?? ""
    if (sensitiveFieldHints.autocompleteValues.includes(autocomplete)) {
      return true
    }
    const normalizedHints = [
      inputType,
      target.getAttribute("name"),
      target.id,
      autocomplete,
      target.getAttribute("aria-label"),
      target.getAttribute("placeholder"),
      target.getAttribute("role"),
      target.getAttribute("data-testid"),
      target.getAttribute("data-test"),
      target.getAttribute("data-qa"),
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizeHint)
    const tokens = normalizedHints.flatMap((value) => value.split(/\s+/))
    if (
      sensitiveFieldHints.exactTokens.some((term) => tokens.includes(term))
    ) {
      return true
    }
    const compactHints = normalizedHints.map((value) =>
      value.replace(/\s+/g, "")
    )
    return sensitiveFieldHints.compactTerms.some((term) =>
      compactHints.some((value) => value.includes(term))
    )
  }

  let bodyText = document.body?.innerText ?? ""
  for (const element of document.querySelectorAll("[contenteditable]")) {
    if (!isSensitiveField(element) || !(element instanceof HTMLElement)) {
      continue
    }
    const sensitiveText = element.innerText
    if (sensitiveText) {
      bodyText = bodyText.split(sensitiveText).join("[redacted]")
    }
  }
  const links = Array.from(document.querySelectorAll("a"))
    .slice(0, 50)
    .map((anchor) => ({
      text: (anchor.textContent ?? "").trim().slice(0, 200),
      href: anchor.href,
    }))
  const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
    .slice(0, 50)
    .map((element) => {
      const input = element as HTMLInputElement
      return {
        name: input.name || input.id || "",
        type: input.type || input.tagName.toLowerCase(),
        placeholder: input.placeholder || "",
      }
    })
  return {
    text:
      bodyText.length > limit
        ? `${bodyText.slice(0, limit)}[truncated ${bodyText.length - limit} chars]`
        : bodyText,
    links,
    inputs,
  }
}

export function evaluateDomAssets({
  maxOccurrences,
  maxBackgroundElements,
}: {
  maxOccurrences: number
  maxBackgroundElements: number
}) {
  type Projection = DomAssetProjection
  const assets: Projection[] = []
  let backgroundElementsScanned = 0
  let backgroundScanTruncated = false
  const hash = (value: string) => {
    let result = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index)
      result = Math.imul(result, 16777619)
    }
    return (result >>> 0).toString(16).padStart(8, "0")
  }
  const identity = (value: string) => {
    if (value.startsWith("data:")) {
      return { identity: `data:${hash(value)}`, scheme: "data" }
    }
    try {
      const url = new URL(value, document.baseURI).href
      return {
        identity: url,
        url,
        scheme: new URL(url).protocol.replace(":", ""),
      }
    } catch {
      return undefined
    }
  }
  const add = (
    kind: AssetKind,
    value: string,
    metadata: Omit<Projection, "identity" | "url" | "scheme" | "kind"> = {}
  ) => {
    if (!value || assets.length >= maxOccurrences) return
    const resolved = identity(value)
    if (!resolved) return
    assets.push({
      kind,
      ...resolved,
      ...metadata,
      inline: resolved.scheme === "data" || metadata.inline,
    })
  }
  for (const image of document.querySelectorAll("img")) {
    const rect = image.getBoundingClientRect()
    add("image", image.currentSrc || image.src, {
      tagName: "img",
      loading: image.loading || undefined,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      intrinsicWidth: image.naturalWidth || undefined,
      intrinsicHeight: image.naturalHeight || undefined,
    })
  }
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    add("stylesheet", (link as HTMLLinkElement).href, { tagName: "link" })
  }
  for (const script of document.querySelectorAll("script[src]")) {
    add("script", (script as HTMLScriptElement).src, { tagName: "script" })
  }
  for (const video of document.querySelectorAll("video[src], video source[src]")) {
    const media = video.closest("video") as HTMLVideoElement | null
    const rect = media?.getBoundingClientRect()
    add("video", (video as HTMLVideoElement).currentSrc || (video as HTMLSourceElement).src, {
      tagName: video.tagName.toLowerCase(),
      renderedWidth: rect?.width,
      renderedHeight: rect?.height,
      intrinsicWidth: media?.videoWidth || undefined,
      intrinsicHeight: media?.videoHeight || undefined,
    })
  }
  for (const audio of document.querySelectorAll("audio[src], audio source[src]")) {
    const media = audio.closest("audio") as HTMLAudioElement | null
    const rect = media?.getBoundingClientRect()
    add("audio", (audio as HTMLAudioElement).currentSrc || (audio as HTMLSourceElement).src, {
      tagName: audio.tagName.toLowerCase(),
      renderedWidth: rect?.width,
      renderedHeight: rect?.height,
    })
  }
  const elements = Array.from(document.querySelectorAll("*"))
  for (const element of elements) {
    if (backgroundElementsScanned >= maxBackgroundElements) {
      backgroundScanTruncated = true
      break
    }
    backgroundElementsScanned += 1
    const background = getComputedStyle(element).backgroundImage
    if (!background || background === "none") continue
    const matches = background.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g)
    for (const match of matches) {
      const rect = element.getBoundingClientRect()
      add("background_image", (match[1] ?? match[2] ?? match[3] ?? "").trim(), {
        tagName: element.tagName.toLowerCase(),
        renderedWidth: rect.width,
        renderedHeight: rect.height,
      })
    }
  }
  let svgSequence = 0
  for (const svg of document.querySelectorAll("svg")) {
    if (assets.length >= maxOccurrences) break
    const rect = svg.getBoundingClientRect()
    const viewBox = svg.viewBox?.baseVal
    assets.push({
      identity: `inline-svg:${++svgSequence}`,
      scheme: "inline",
      kind: "inline_svg",
      tagName: "svg",
      inline: true,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      viewBox: viewBox
        ? { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height }
        : undefined,
    })
  }
  const performanceEntries = performance
    .getEntriesByType("resource")
    .slice(-maxOccurrences)
    .map((entry) => {
      const timing = entry as PerformanceResourceTiming
      const resolved = identity(timing.name)
      if (!resolved) return undefined
      return {
        ...resolved,
        initiatorType: timing.initiatorType,
        startTime: timing.startTime,
        duration: timing.duration,
        transferSize: timing.transferSize,
        encodedBodySize: timing.encodedBodySize,
        decodedBodySize: timing.decodedBodySize,
      } satisfies PerformanceAssetProjection
    })
    .filter((entry): entry is PerformanceAssetProjection => entry != null)
  return {
    assets,
    performanceEntries,
    backgroundElementsScanned,
    backgroundScanTruncated,
  }
}

export function evaluatePerformanceSummary(): PerformancePageProjection {
  const reader = (
    window as unknown as {
      __chromePowerPerformanceReader?: () => PerformanceObserverProjection
    }
  ).__chromePowerPerformanceReader
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined
  const paints = Object.fromEntries(
    performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime])
  )
  const hash = (value: string) => {
    let result = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index)
      result = Math.imul(result, 16777619)
    }
    return (result >>> 0).toString(16).padStart(8, "0")
  }
  const resources = performance.getEntriesByType("resource").map((entry) => {
    const timing = entry as PerformanceResourceTiming
    const isData = timing.name.startsWith("data:")
    let scheme = "unknown"
    if (isData) scheme = "data"
    else {
      try { scheme = new URL(timing.name).protocol.replace(":", "") } catch {}
    }
    return {
      url: isData ? undefined : timing.name,
      identity: isData ? `data:${hash(timing.name)}` : timing.name,
      scheme,
      initiatorType: timing.initiatorType,
      startTime: timing.startTime,
      duration: timing.duration,
      transferSize: timing.transferSize,
      encodedBodySize: timing.encodedBodySize,
      decodedBodySize: timing.decodedBodySize,
    }
  })
  return {
    observer: reader?.(),
    timeOrigin: performance.timeOrigin,
    navigation: navigation
      ? {
          type: navigation.type,
          startTime: navigation.startTime,
          redirectStart: navigation.redirectStart,
          redirectEnd: navigation.redirectEnd,
          domainLookupStart: navigation.domainLookupStart,
          domainLookupEnd: navigation.domainLookupEnd,
          connectStart: navigation.connectStart,
          secureConnectionStart: navigation.secureConnectionStart,
          connectEnd: navigation.connectEnd,
          requestStart: navigation.requestStart,
          responseStart: navigation.responseStart,
          responseEnd: navigation.responseEnd,
          domContentLoadedEventStart: navigation.domContentLoadedEventStart,
          domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
          domComplete: navigation.domComplete,
          loadEventStart: navigation.loadEventStart,
          loadEventEnd: navigation.loadEventEnd,
        }
      : undefined,
    paints,
    resources,
  }
}

export function installPerformanceObserver() {
  const supported = Array.from(PerformanceObserver.supportedEntryTypes ?? [])
  let lcp: number | undefined
  let clsMax = 0
  let clsWindow = 0
  let clsWindowStart = 0
  let clsLast = 0
  let longCount = 0
  let longTotal = 0
  let longMax = 0
  let blocking = 0
  const interactions = new Map<number, number>()
  const observe = (
    type: string,
    handle: (entry: PerformanceEntry) => void,
    options: Record<string, unknown> = {}
  ) => {
    if (!supported.includes(type)) return
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handle(entry)
      }).observe({ type, buffered: true, ...options } as PerformanceObserverInit)
    } catch {
      // Unsupported observer options are reported through supported types.
    }
  }
  observe("largest-contentful-paint", (entry) => {
    lcp = entry.startTime
  })
  observe("layout-shift", (entry) => {
    const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
    if (shift.hadRecentInput || shift.value == null) return
    if (entry.startTime - clsLast < 1_000 && entry.startTime - clsWindowStart < 5_000) {
      clsWindow += shift.value
    } else {
      clsWindow = shift.value
      clsWindowStart = entry.startTime
    }
    clsLast = entry.startTime
    clsMax = Math.max(clsMax, clsWindow)
  })
  observe("longtask", (entry) => {
    longCount += 1
    longTotal += entry.duration
    longMax = Math.max(longMax, entry.duration)
    blocking += Math.max(entry.duration - 50, 0)
  })
  observe("event", (entry) => {
    const event = entry as PerformanceEntry & { interactionId?: number }
    if (!event.interactionId) return
    interactions.set(
      event.interactionId,
      Math.max(interactions.get(event.interactionId) ?? 0, entry.duration)
    )
    if (interactions.size > 500) {
      const first = interactions.keys().next().value
      if (first != null) interactions.delete(first)
    }
  }, { durationThreshold: 16 })
  const reader = () => {
    const durations = [...interactions.values()].sort((a, b) => b - a)
    const inpIndex = Math.min(Math.floor(durations.length / 50), 9)
    return {
      installed: true,
      supportedEntryTypes: supported,
      lcp,
      cls: supported.includes("layout-shift") ? clsMax : undefined,
      longTasks: supported.includes("longtask")
        ? { count: longCount, total: longTotal, max: longMax, blocking }
        : undefined,
      interactionCount: interactions.size,
      inp: durations[inpIndex],
    }
  }
  Object.defineProperty(window, "__chromePowerPerformanceReader", {
    value: reader,
    enumerable: false,
    writable: false,
    configurable: false,
  })
}

export function readSnapshotElement(
  element: Element,
  sensitiveFieldHints: SensitiveFieldHints
): SnapshotElementData | null {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.opacity === "0"
  ) {
    return null
  }

  const tag = element.tagName.toLowerCase()
  const sensitive = isSensitiveField(element)
  const rawValue = getElementValue(element)
  const text = sensitive ? undefined : getVisibleText(element)
  const name = getAccessibleName(element, text, sensitive)
  const value = !sensitive ? summarize(rawValue, 100) : undefined
  const valueRedacted =
    sensitive && rawValue != null && rawValue.length > 0 ? true : undefined
  const disabled = isDisabled(element)
  const checked = getChecked(element)
  const href =
    element instanceof HTMLAnchorElement
      ? element.href
      : summarize(element.getAttribute("href"), 2_000)

  return {
    tag,
    role: summarize(element.getAttribute("role"), 80) ?? inferNativeRole(element),
    name,
    text,
    placeholder:
      "placeholder" in element
        ? summarize((element as HTMLInputElement).placeholder, 200)
        : undefined,
    value,
    valueRedacted,
    disabled: disabled || undefined,
    checked,
    href,
    box: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  }

  function getAccessibleName(
    target: Element,
    visibleText: string | undefined,
    isSensitive: boolean
  ) {
    return (
      summarize(target.getAttribute("aria-label"), 200) ??
      getLabelledByText(target) ??
      getAssociatedLabelText(target) ??
      summarize(target.getAttribute("alt"), 200) ??
      summarize(target.getAttribute("title"), 200) ??
      getButtonValue(target) ??
      (isSensitive ? undefined : visibleText)
    )
  }

  function getLabelledByText(target: Element) {
    const labelledBy = target.getAttribute("aria-labelledby")
    if (!labelledBy) return undefined
    return summarize(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
      200
    )
  }

  function getAssociatedLabelText(target: Element) {
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      const labelText = Array.from(target.labels ?? [])
        .map((label) => label.innerText || label.textContent || "")
        .join(" ")
      return summarize(labelText, 200)
    }
    return summarize(target.closest("label")?.textContent, 200)
  }

  function getButtonValue(target: Element) {
    if (!(target instanceof HTMLInputElement)) return undefined
    return ["button", "submit", "reset"].includes(target.type)
      ? summarize(target.value, 200)
      : undefined
  }

  function getVisibleText(target: Element) {
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return undefined
    }
    if (target instanceof HTMLElement) {
      return summarize(target.innerText, 200)
    }
    return summarize(target.textContent, 200)
  }

  function getElementValue(target: Element) {
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return target.value
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      return target.innerText
    }
    return undefined
  }

  function isSensitiveField(target: Element) {
    const inputType =
      target instanceof HTMLInputElement ? target.type.toLowerCase() : ""
    if (inputType === "password") return true

    const autocomplete =
      target.getAttribute("autocomplete")?.trim().toLowerCase() ?? ""
    if (sensitiveFieldHints.autocompleteValues.includes(autocomplete)) {
      return true
    }
    const normalizedHints = [
      inputType,
      target.getAttribute("name"),
      target.id,
      autocomplete,
      target.getAttribute("aria-label"),
      target.getAttribute("placeholder"),
      target.getAttribute("role"),
      target.getAttribute("data-testid"),
      target.getAttribute("data-test"),
      target.getAttribute("data-qa"),
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) =>
        value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
      )
    const tokens = normalizedHints.flatMap((value) => value.split(/\s+/))
    if (
      sensitiveFieldHints.exactTokens.some((term) => tokens.includes(term))
    ) {
      return true
    }
    const compactHints = normalizedHints.map((value) =>
      value.replace(/\s+/g, "")
    )

    return sensitiveFieldHints.compactTerms.some((term) =>
      compactHints.some((value) => value.includes(term))
    )
  }

  function isDisabled(target: Element) {
    return (
      target.matches(":disabled") ||
      target.getAttribute("aria-disabled")?.toLowerCase() === "true"
    )
  }

  function getChecked(target: Element) {
    if (target instanceof HTMLInputElement) {
      if (target.type === "checkbox" || target.type === "radio") {
        return target.checked
      }
    }

    const ariaChecked = target.getAttribute("aria-checked")?.toLowerCase()
    if (ariaChecked === "true") return true
    if (ariaChecked === "false") return false
    return undefined
  }

  function inferNativeRole(target: Element) {
    if (target instanceof HTMLAnchorElement && target.href) return "link"
    if (target instanceof HTMLButtonElement) return "button"
    if (target instanceof HTMLTextAreaElement) return "textbox"
    if (target instanceof HTMLSelectElement) return "combobox"
    if (!(target instanceof HTMLInputElement)) return undefined

    switch (target.type) {
      case "button":
      case "submit":
      case "reset":
        return "button"
      case "checkbox":
        return "checkbox"
      case "radio":
        return "radio"
      case "range":
        return "slider"
      default:
        return "textbox"
    }
  }

  function summarize(value: string | null | undefined, limit: number) {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim()
    if (!normalized) return undefined
    return normalized.length > limit ? normalized.slice(0, limit) : normalized
  }
}

export function readPointCandidateExtras(element: Element): {
  testId?: string
  locator?: {
    selector?: string
    testId?: string
    exact?: true
  }
  insideFrame: boolean
} {
  const bounded = (value: string | null, max: number) => {
    const normalized = value?.replace(/\s+/g, " ").trim()
    return normalized ? normalized.slice(0, max) : undefined
  }
  const testId = bounded(element.getAttribute("data-testid"), 200)
  if (
    testId &&
    [...document.querySelectorAll("[data-testid]")].filter(
      (candidate) => candidate.getAttribute("data-testid") === testId
    ).length === 1
  ) {
    return {
      testId,
      locator: { testId, exact: true },
      insideFrame: element instanceof HTMLIFrameElement,
    }
  }
  const id = bounded(element.id, 200)
  if (
    id &&
    [...document.querySelectorAll("[id]")].filter(
      (candidate) => candidate.id === id
    ).length === 1
  ) {
    return {
      testId,
      locator: { selector: `#${CSS.escape(id)}` },
      insideFrame: element instanceof HTMLIFrameElement,
    }
  }
  return {
    testId,
    insideFrame: element instanceof HTMLIFrameElement,
  }
}
