import type { Frame, Locator, Page } from "playwright"

import type { LocatorQuery } from "./contracts.js"
import { BrowserToolError } from "./errors.js"
import { errorMessage, hasValue } from "./validation-utils.js"

export type FrameLike = Page | Frame

export function locatorForQuery(
  page: FrameLike,
  query: LocatorQuery,
  options: { allowIndex: boolean; action: string }
): Locator {
  const hasSelector = hasValue(query.selector)
  const hasRole = hasValue(query.role)
  const hasText = hasValue(query.text)
  const hasLabel = hasValue(query.label)
  const hasPlaceholder = hasValue(query.placeholder)
  const hasTestId = hasValue(query.testId)
  const baseCount =
    Number(hasSelector) +
    Number(hasRole) +
    Number(hasText) +
    Number(hasLabel) +
    Number(hasPlaceholder) +
    Number(hasTestId)

  if (baseCount !== 1) {
    throw new BrowserToolError(
      "invalid_request",
      "Provide exactly one locator base: selector, role, text, label, placeholder, or testId."
    )
  }

  if (hasValue(query.name) && !hasRole) {
    throw new BrowserToolError(
      "invalid_request",
      "locator.name is valid only with locator.role."
    )
  }

  if (
    query.exact != null &&
    !(hasRole || hasText || hasLabel || hasPlaceholder)
  ) {
    throw new BrowserToolError(
      "invalid_request",
      "locator.exact is valid only with role, text, label, or placeholder locators."
    )
  }

  if (query.index != null && !options.allowIndex) {
    throw new BrowserToolError(
      "invalid_request",
      `locator.index is not valid for ${options.action}.`
    )
  }

  let locator: Locator
  if (hasSelector) {
    locator = page.locator(query.selector as string)
  } else if (hasRole) {
    locator = page.getByRole(query.role as Parameters<Page["getByRole"]>[0], {
      name: hasValue(query.name) ? query.name : undefined,
      exact: query.exact,
    })
  } else if (hasText) {
    locator = page.getByText(query.text as string, { exact: query.exact })
  } else if (hasLabel) {
    locator = page.getByLabel(query.label as string, { exact: query.exact })
  } else if (hasPlaceholder) {
    locator = page.getByPlaceholder(query.placeholder as string, {
      exact: query.exact,
    })
  } else {
    locator = page.getByTestId(query.testId as string)
  }

  return query.index == null ? locator : locator.nth(query.index)
}

export async function withLocatorNotFound<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof BrowserToolError) throw error
    const message = errorMessage(error)
    if (message.toLowerCase().includes("strict mode violation")) {
      throw new BrowserToolError(
        "invalid_request",
        "Locator matched multiple elements. Provide locator.index to choose one."
      )
    }
    throw new BrowserToolError("locator_not_found", message)
  }
}
