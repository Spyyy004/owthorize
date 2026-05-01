import type { Guard } from "../guard"
import { type AnyHandler, type PerToolOptions, wrapHandler } from "./_shared"

export interface LangChainTool {
  name: string
  description?: string
  schema?: unknown
  func?: AnyHandler
  _call?: AnyHandler
  [k: string]: unknown
}

export function protectTools(
  guard: Guard,
  tools: readonly LangChainTool[],
  perTool: Record<string, PerToolOptions> = {},
): LangChainTool[] {
  return tools.map((t) => {
    if (!t || typeof t.name !== "string" || !t.name) {
      throw new Error("langchain shim: each tool must have a string `name`")
    }

    const handler = pickHandler(t)
    if (!handler) return { ...t }

    const wrapped = wrapHandler(guard, t.name, handler, perTool[t.name])
    if (t.func) return { ...t, func: wrapped }
    return { ...t, _call: wrapped }
  })
}

function pickHandler(t: LangChainTool): AnyHandler | null {
  if (typeof t.func === "function") return t.func
  if (typeof t._call === "function") return t._call.bind(t)
  return null
}
