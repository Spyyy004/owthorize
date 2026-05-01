import type { Guard } from "../guard"
import type { AnyHandler, PerToolOptions } from "./_shared"

/**
 * Minimal structural shape this shim cares about. Compatible with the Tool
 * objects returned by Vercel AI's `tool()` helper (which have additional
 * required fields like `inputSchema`); the shim doesn't need those.
 */
export interface VercelTool {
  description?: string
  inputSchema?: unknown
  parameters?: unknown
  execute?: AnyHandler
}

export function protectTools<T extends Record<string, VercelTool>>(
  guard: Guard,
  tools: T,
  perTool: Record<string, PerToolOptions> = {},
): T {
  if (!tools || typeof tools !== "object") {
    throw new Error("vercel-ai shim: tools must be a Record<name, ToolDef>")
  }

  const out: Record<string, VercelTool> = {}
  for (const name of Object.keys(tools)) {
    const t = tools[name]
    if (!t || typeof t !== "object") {
      throw new Error(`vercel-ai shim: tool '${name}' must be an object`)
    }
    if (typeof t.execute !== "function") {
      out[name] = { ...t }
      continue
    }

    const userExecute = t.execute
    // Register the tool with a no-op handler so rule eval + audit run, but the
    // actual work happens below — preserving Vercel's `(input, options)` shape.
    const ruleCheck = guard.tool<unknown, void>(name, {
      adapter: perTool[name]?.adapter,
      redact: perTool[name]?.redact,
      handler: async () => undefined,
    })
    const execute: AnyHandler = async (input: unknown, ...rest: unknown[]) => {
      await ruleCheck(input) // throws GuardDenied on deny; no-op on allow
      return userExecute(input, ...rest)
    }
    out[name] = { ...t, execute }
  }
  return out as T
}
