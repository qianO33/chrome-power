import type { FrameLike } from "./locator-query.js"
import { locatorForQuery, withLocatorNotFound } from "./locator-query.js"
import { resolveSelectOption } from "./target-resolution.js"
import { BrowserToolError } from "./errors.js"
import type {
  LocatorAttributeData,
  LocatorCountData,
  LocatorQuery,
  LocatorStateData,
  LocatorTextData,
  LocatorTextKind,
  LocatorWaitState,
} from "./contracts.js"

const DEFAULT_TIMEOUT_MS = 15_000

type LocatorTarget = {
  locator: LocatorQuery
}

export async function locatorCountOp(
  frame: FrameLike,
  options: LocatorTarget
): Promise<LocatorCountData> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: false,
    action: "count",
  })
  const count = await locator.count()
  return { count }
}

export async function locatorTextOp(
  frame: FrameLike,
  options: LocatorTarget & {
    all?: boolean
    textKind?: LocatorTextKind
    timeoutMs?: number
  }
): Promise<LocatorTextData> {
  const textKind = options.textKind ?? "innerText"
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: !options.all,
    action: "read text",
  })

  if (options.all) {
    const texts =
      textKind === "innerText"
        ? await locator.allInnerTexts()
        : await locator.allTextContents()
    return { texts }
  }

  const text = await withLocatorNotFound(() =>
    textKind === "innerText"
      ? locator.innerText({ timeout })
      : locator.textContent({ timeout })
  )
  return { text }
}

export async function locatorAttributeOp(
  frame: FrameLike,
  options: LocatorTarget & {
    name: string
    timeoutMs?: number
  }
): Promise<LocatorAttributeData> {
  const name = options.name.trim()
  if (!name) {
    throw new BrowserToolError(
      "invalid_request",
      "Attribute name is required."
    )
  }
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "read attribute",
  })
  const value = await withLocatorNotFound(() =>
    locator.getAttribute(name, { timeout })
  )
  return { name, value }
}

export async function locatorStateOp(
  frame: FrameLike,
  options: LocatorTarget
): Promise<LocatorStateData> {
  const baseLocator = locatorForQuery(frame, options.locator, {
    allowIndex: false,
    action: "inspect state",
  })
  const targetLocator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "inspect state",
  })
  const count = await baseLocator.count()
  const visible = count > 0 ? await targetLocator.isVisible() : false
  const enabled =
    count > 0 ? await targetLocator.isEnabled().catch(() => false) : false
  return { count, visible, enabled }
}

export async function locatorWaitOp(
  frame: FrameLike,
  options: LocatorTarget & {
    state?: LocatorWaitState
    timeoutMs?: number
  }
): Promise<{ waited: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "wait",
  })
  await withLocatorNotFound(() =>
    locator.waitFor({
      state: options.state ?? "visible",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  )
  return { waited: true }
}

export async function locatorClickOp(
  frame: FrameLike,
  options: LocatorTarget & { timeoutMs?: number },
  captureDialog: (operation: () => Promise<unknown>) => Promise<void>
): Promise<{ clicked: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "click",
  })
  await withLocatorNotFound(() =>
    captureDialog(() =>
      locator.click({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
    )
  )
  return { clicked: true }
}

export async function locatorDoubleClickOp(
  frame: FrameLike,
  options: LocatorTarget & { timeoutMs?: number },
  captureDialog: (operation: () => Promise<unknown>) => Promise<void>
): Promise<{ doubleClicked: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "double click",
  })
  await withLocatorNotFound(() =>
    captureDialog(() =>
      locator.dblclick({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
    )
  )
  return { doubleClicked: true }
}

export async function locatorTypeOp(
  frame: FrameLike,
  options: LocatorTarget & {
    text: string
    clear?: boolean
    timeoutMs?: number
  }
): Promise<{ typed: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "type",
  })
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await withLocatorNotFound(() =>
    options.clear === false
      ? locator.type(options.text, { timeout })
      : locator.fill(options.text, { timeout })
  )
  return { typed: true }
}

export async function locatorPressOp(
  frame: FrameLike,
  options: LocatorTarget & {
    key: string
    timeoutMs?: number
  },
  captureDialog: (operation: () => Promise<unknown>) => Promise<void>
): Promise<{ pressed: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "press",
  })
  await withLocatorNotFound(() =>
    captureDialog(() =>
      locator.press(options.key, {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
    )
  )
  return { pressed: true }
}

export async function locatorHoverOp(
  frame: FrameLike,
  options: LocatorTarget & { timeoutMs?: number }
): Promise<{ hovered: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "hover",
  })
  await withLocatorNotFound(() =>
    locator.hover({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  )
  return { hovered: true }
}

export async function locatorFocusOp(
  frame: FrameLike,
  options: LocatorTarget & { timeoutMs?: number }
): Promise<{ focused: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "focus",
  })
  await withLocatorNotFound(() =>
    locator.focus({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  )
  return { focused: true }
}

export async function locatorScrollOp(
  frame: FrameLike,
  options: LocatorTarget & {
    deltaX?: number
    deltaY?: number
    timeoutMs?: number
  }
): Promise<{ scrolled: true }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "scroll",
  })
  await withLocatorNotFound(() =>
    locator.evaluate(
      (element, delta) => element.scrollBy(delta.x, delta.y),
      { x: options.deltaX ?? 0, y: options.deltaY ?? 700 },
      { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }
    )
  )
  return { scrolled: true }
}

export async function locatorSetCheckedOp(
  frame: FrameLike,
  options: LocatorTarget & {
    checked: boolean
    timeoutMs?: number
  }
): Promise<{ checked: boolean }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "set checked",
  })
  await withLocatorNotFound(() =>
    locator.setChecked(options.checked, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  )
  return { checked: options.checked }
}

export async function locatorSelectOptionOp(
  frame: FrameLike,
  options: LocatorTarget & {
    value?: string
    label?: string
    index?: number
    timeoutMs?: number
  }
): Promise<{ selected: true; values: string[] }> {
  const locator = locatorForQuery(frame, options.locator, {
    allowIndex: true,
    action: "select option",
  })
  const option = resolveSelectOption(options)
  const values = await withLocatorNotFound(() =>
    locator.selectOption(option, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  )
  return { selected: true, values }
}
