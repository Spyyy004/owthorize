import type { Guard } from "../guard"
import { type AnyHandler, type PerToolOptions, wrapHandler } from "./_shared"

export interface OpenAITool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: unknown
    [k: string]: unknown
  }
  handler?: AnyHandler
  [k: string]: unknown
}

export function protectTools(
  guard: Guard,
  tools: readonly OpenAITool[],
  perTool: Record<string, PerToolOptions> = {},
): OpenAITool[] {
  return tools.map((t) => {
    if (!t || t.type !== "function" || !t.function?.name) {
      throw new Error("openai shim: each tool must have type:'function' and function.name")
    }
    if (!t.handler) return { ...t }
    const name = t.function.name
    const wrapped = wrapHandler(guard, name, t.handler, perTool[name])
    return { ...t, handler: wrapped }
  })
}
