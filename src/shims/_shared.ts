import type { Guard } from "../guard"

export interface PerToolOptions {
  adapter?: string
  redact?: string[]
}

export type AnyHandler = (...args: any[]) => any

export function wrapHandler(
  guard: Guard,
  name: string,
  handler: AnyHandler,
  opts: PerToolOptions = {},
): AnyHandler {
  return guard.tool<unknown, unknown>(name, {
    adapter: opts.adapter,
    redact: opts.redact,
    handler: handler as (input: unknown) => unknown,
  })
}
