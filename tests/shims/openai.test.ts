import { describe, expect, it } from "vitest"
import { GuardDenied } from "../../src/decision"
import { Guard } from "../../src/guard"
import { denyDDL } from "../../src/rules/sql"
import { type OpenAITool, protectTools } from "../../src/shims/openai"

describe("openai shim — protectTools", () => {
  it("wraps a handler so guard rules deny at call time", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: { name: "db_query", description: "run SQL", parameters: {} },
        handler: async ({ query }: { query: string }) => ({ rows: [], query }),
      },
    ]

    const safe = protectTools(guard, tools, {
      db_query: { adapter: "sql.postgres" },
    })
    expect(safe).toHaveLength(1)
    expect(safe[0].function.name).toBe("db_query")
    await expect(safe[0].handler!({ query: "DROP TABLE users" })).rejects.toBeInstanceOf(
      GuardDenied,
    )
  })

  it("invokes handler when allowed", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    let invoked = false
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: { name: "db_query" },
        handler: async ({ query }: { query: string }) => {
          invoked = true
          return { ok: true, query }
        },
      },
    ]
    const safe = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
    const result = await safe[0].handler!({ query: "SELECT 1" })
    expect(invoked).toBe(true)
    expect(result).toEqual({ ok: true, query: "SELECT 1" })
  })

  it("preserves arbitrary OpenAI fields like `strict`", () => {
    const guard = new Guard()
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: { name: "x", strict: true, description: "d", parameters: { x: 1 } },
        handler: async () => null,
      },
    ]
    const safe = protectTools(guard, tools)
    expect(safe[0].function.strict).toBe(true)
    expect(safe[0].function.description).toBe("d")
    expect(safe[0].function.parameters).toEqual({ x: 1 })
  })

  it("passes schema-only tools through untouched", () => {
    const guard = new Guard()
    const tools: OpenAITool[] = [{ type: "function", function: { name: "schema_only" } }]
    const safe = protectTools(guard, tools)
    expect(safe[0].handler).toBeUndefined()
  })

  it("throws on a tool missing function.name", () => {
    const guard = new Guard()
    expect(() =>
      protectTools(guard, [{ type: "function", function: {} as never, handler: async () => null }]),
    ).toThrow(/function\.name/)
  })

  it("supports per-tool redact override", async () => {
    const guard = new Guard()
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: { name: "secret_call" },
        handler: async (i: { token: string }) => i.token,
      },
    ]
    const safe = protectTools(guard, tools, {
      secret_call: { redact: ["token"] },
    })
    const out = await safe[0].handler!({ token: "abc" })
    expect(out).toBe("abc")
  })

  it("throws when registering duplicate tool names via Guard.tool", () => {
    const guard = new Guard()
    const tools: OpenAITool[] = [
      { type: "function", function: { name: "dup" }, handler: async () => 1 },
      { type: "function", function: { name: "dup" }, handler: async () => 2 },
    ]
    expect(() => protectTools(guard, tools)).toThrow(/already registered/)
  })
})
