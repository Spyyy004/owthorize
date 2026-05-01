import type { Guard } from "../guard"
import { type AnyHandler, type PerToolOptions, wrapHandler } from "./_shared"

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: unknown
  handler?: AnyHandler
  [k: string]: unknown
}

export function protectTools(
  guard: Guard,
  tools: readonly AnthropicTool[],
  perTool: Record<string, PerToolOptions> = {},
): AnthropicTool[] {
  return tools.map((t) => {
    if (!t || typeof t.name !== "string" || !t.name) {
      throw new Error("anthropic shim: each tool must have a string `name`")
    }
    if (!t.handler) return { ...t }
    const wrapped = wrapHandler(guard, t.name, t.handler, perTool[t.name])
    return { ...t, handler: wrapped }
  })
}
