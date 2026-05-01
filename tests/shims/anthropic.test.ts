import { describe, expect, it } from "vitest"
import { GuardDenied } from "../../src/decision"
import { Guard } from "../../src/guard"
import { denyDDL } from "../../src/rules/sql"
import { type AnthropicTool, protectTools } from "../../src/shims/anthropic"

describe("anthropic shim — protectTools", () => {
  it("wraps a handler so guard rules deny at call time", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools: AnthropicTool[] = [
      {
        name: "db_query",
        description: "run SQL",
        input_schema: { type: "object" },
        handler: async ({ query }: { query: string }) => ({ rows: [], query }),
      },
    ]

    const safe = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
    expect(safe[0].name).toBe("db_query")
    await expect(safe[0].handler!({ query: "DROP TABLE users" })).rejects.toBeInstanceOf(
      GuardDenied,
    )
  })

  it("invokes handler when allowed", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools: AnthropicTool[] = [
      {
        name: "db_query",
        handler: async ({ query }: { query: string }) => ({ ok: true, query }),
      },
    ]
    const safe = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
    expect(await safe[0].handler!({ query: "SELECT 1" })).toEqual({
      ok: true,
      query: "SELECT 1",
    })
  })

  it("preserves description and input_schema", () => {
    const guard = new Guard()
    const tools: AnthropicTool[] = [
      {
        name: "x",
        description: "desc",
        input_schema: { type: "object", properties: { y: { type: "string" } } },
        handler: async () => null,
      },
    ]
    const safe = protectTools(guard, tools)
    expect(safe[0].description).toBe("desc")
    expect(safe[0].input_schema).toMatchObject({ type: "object" })
  })

  it("passes schema-only tools through untouched", () => {
    const guard = new Guard()
    const tools: AnthropicTool[] = [{ name: "schema_only" }]
    const safe = protectTools(guard, tools)
    expect(safe[0].handler).toBeUndefined()
  })

  it("throws when tool is missing name", () => {
    const guard = new Guard()
    expect(() => protectTools(guard, [{ handler: async () => null } as never])).toThrow(/name/)
  })

  it("throws when registering duplicate names", () => {
    const guard = new Guard()
    const tools: AnthropicTool[] = [
      { name: "dup", handler: async () => 1 },
      { name: "dup", handler: async () => 2 },
    ]
    expect(() => protectTools(guard, tools)).toThrow(/already registered/)
  })
})
