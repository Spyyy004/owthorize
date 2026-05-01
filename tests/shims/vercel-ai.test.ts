import { describe, expect, it } from "vitest"
import { GuardDenied } from "../../src/decision"
import { Guard } from "../../src/guard"
import { denyDDL } from "../../src/rules/sql"
import { type VercelTool, protectTools } from "../../src/shims/vercel-ai"

describe("vercel-ai shim — protectTools", () => {
  it("wraps execute() so guard rules deny at call time", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools = {
      db_query: {
        description: "run SQL",
        parameters: { type: "object" },
        execute: async ({ query }: { query: string }) => ({ rows: [], query }),
      } as VercelTool,
    }
    const safe = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
    await expect(safe.db_query.execute!({ query: "DROP TABLE users" })).rejects.toBeInstanceOf(
      GuardDenied,
    )
  })

  it("invokes execute when allowed", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools = {
      db_query: {
        execute: async ({ query }: { query: string }) => ({ ok: true, query }),
      } as VercelTool,
    }
    const safe = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
    expect(await safe.db_query.execute!({ query: "SELECT 1" })).toEqual({
      ok: true,
      query: "SELECT 1",
    })
  })

  it("uses the record key as the tool name", async () => {
    const guard = new Guard({ rules: [denyDDL()] })
    const tools = {
      my_funky_name: {
        execute: async () => "ok",
      } as VercelTool,
    }
    const safe = protectTools(guard, tools)
    // Calling against a different key should not exist
    expect(Object.keys(safe)).toEqual(["my_funky_name"])
    expect(await safe.my_funky_name.execute!({})).toBe("ok")
  })

  it("preserves description and parameters", () => {
    const guard = new Guard()
    const tools = {
      x: {
        description: "desc",
        parameters: { type: "object", properties: { y: { type: "string" } } },
        execute: async () => null,
      } as VercelTool,
    }
    const safe = protectTools(guard, tools)
    expect(safe.x.description).toBe("desc")
    expect(safe.x.parameters).toMatchObject({ type: "object" })
  })

  it("passes client-side tools (no execute) through untouched", () => {
    const guard = new Guard()
    const tools = {
      client_side: { description: "no execute" } as VercelTool,
    }
    const safe = protectTools(guard, tools)
    expect(safe.client_side.execute).toBeUndefined()
    expect(safe.client_side.description).toBe("no execute")
  })

  it("throws on non-object input", () => {
    const guard = new Guard()
    expect(() => protectTools(guard, null as never)).toThrow(/Record/)
  })

  it("throws on non-object tool entry", () => {
    const guard = new Guard()
    expect(() => protectTools(guard, { bad: 42 as never })).toThrow(/must be an object/)
  })

  it("throws on duplicate name across calls (Guard rejects)", () => {
    const guard = new Guard()
    protectTools(guard, { dup: { execute: async () => 1 } as VercelTool })
    expect(() => protectTools(guard, { dup: { execute: async () => 2 } as VercelTool })).toThrow(
      /already registered/,
    )
  })

  it("forwards Vercel's second-arg `options` to the user's execute", async () => {
    const guard = new Guard()
    let observedOptions: unknown
    const tools = {
      probe: {
        execute: async (input: unknown, options: unknown) => {
          observedOptions = options
          return { input }
        },
      } as VercelTool,
    }
    const safe = protectTools(guard, tools)
    const fakeOptions = { toolCallId: "abc-123", messages: [] }
    await safe.probe.execute!({ x: 1 }, fakeOptions)
    expect(observedOptions).toBe(fakeOptions)
  })

  it("does not double-call execute on the allow path", async () => {
    const guard = new Guard()
    let callCount = 0
    const tools = {
      counter: {
        execute: async () => {
          callCount += 1
          return callCount
        },
      } as VercelTool,
    }
    const safe = protectTools(guard, tools)
    await safe.counter.execute!({})
    expect(callCount).toBe(1)
  })
})
