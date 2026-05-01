import { describe, expect, it } from "vitest"
import { GuardDenied } from "../../src/decision"
import { Guard } from "../../src/guard"
import { denyDDL } from "../../src/rules/sql"
import { type LangChainTool, protectTools } from "../../src/shims/langchain"

describe("langchain shim — protectTools", () => {
  it("wraps `func` so guard rules deny at call time", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools: LangChainTool[] = [
      {
        name: "db_query",
        description: "run SQL",
        schema: { type: "object" },
        func: async ({ query }: { query: string }) => ({ rows: [], query }),
      },
    ]
    const safe = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
    expect(safe[0].name).toBe("db_query")
    await expect(safe[0].func!({ query: "DROP TABLE users" })).rejects.toBeInstanceOf(GuardDenied)
  })

  it("wraps `_call` (legacy Tool subclass shape)", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools: LangChainTool[] = [
      {
        name: "legacy_tool",
        _call: async ({ query }: { query: string }) => `ran: ${query}`,
      },
    ]
    const safe = protectTools(guard, tools, { legacy_tool: { adapter: "sql.postgres" } })
    await expect(safe[0]._call!({ query: "DROP TABLE x" })).rejects.toBeInstanceOf(GuardDenied)
  })

  it("invokes handler when allowed", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools: LangChainTool[] = [
      {
        name: "db_query",
        func: async ({ query }: { query: string }) => ({ ok: true, query }),
      },
    ]
    const safe = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
    expect(await safe[0].func!({ query: "SELECT 1" })).toEqual({ ok: true, query: "SELECT 1" })
  })

  it("preserves description and schema", () => {
    const guard = new Guard()
    const tools: LangChainTool[] = [
      {
        name: "x",
        description: "desc",
        schema: { type: "object", properties: { y: { type: "string" } } },
        func: async () => null,
      },
    ]
    const safe = protectTools(guard, tools)
    expect(safe[0].description).toBe("desc")
    expect(safe[0].schema).toMatchObject({ type: "object" })
  })

  it("passes schema-only tools through untouched", () => {
    const guard = new Guard()
    const tools: LangChainTool[] = [{ name: "schema_only", description: "no handler" }]
    const safe = protectTools(guard, tools)
    expect(safe[0].func).toBeUndefined()
    expect(safe[0]._call).toBeUndefined()
  })

  it("throws when tool is missing name", () => {
    const guard = new Guard()
    expect(() => protectTools(guard, [{ func: async () => null } as never])).toThrow(/name/)
  })

  it("throws when registering duplicate names", () => {
    const guard = new Guard()
    const tools: LangChainTool[] = [
      { name: "dup", func: async () => 1 },
      { name: "dup", func: async () => 2 },
    ]
    expect(() => protectTools(guard, tools)).toThrow(/already registered/)
  })
})
