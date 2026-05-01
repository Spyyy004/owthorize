import { describe, expect, it } from "vitest"
import { ALLOW, Guard, GuardDenied, deny, registerAdapter, rules, silentSink } from "../src/index"
import type { SqlParams } from "../src/index"

describe("decision types", () => {
  it("ALLOW is the canonical allow", () => {
    expect(ALLOW.decision).toBe("allow")
  })

  it("deny() builds a deny decision", () => {
    expect(deny("nope", "rule.x")).toEqual({
      decision: "deny",
      reason: "nope",
      matched: "rule.x",
    })
  })

  it("deny() carries irreversible flag when supplied", () => {
    expect(deny("nope", "rule.x", { irreversible: true })).toEqual({
      decision: "deny",
      reason: "nope",
      matched: "rule.x",
      irreversible: true,
    })
  })

  it("deny() omits irreversible field when flag is false/undefined", () => {
    const d = deny("nope", "rule.x", { irreversible: false })
    expect(d).toEqual({ decision: "deny", reason: "nope", matched: "rule.x" })
    expect("irreversible" in d).toBe(false)
  })

  it("GuardDenied carries fields and is an Error", () => {
    const e = new GuardDenied({ tool: "db.query", reason: "no", matched: "r1" })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe("GuardDenied")
    expect(e.tool).toBe("db.query")
    expect(e.matched).toBe("r1")
    expect(e.irreversible).toBe(false)
    expect(e.message).toContain("db.query")
    expect(e.message).toContain("no")
  })

  it("GuardDenied carries irreversible when set", () => {
    const e = new GuardDenied({
      tool: "db.query",
      reason: "no",
      matched: "r1",
      irreversible: true,
    })
    expect(e.irreversible).toBe(true)
  })
})

describe("public API surface", () => {
  it("exports Guard, GuardDenied, rules, registerAdapter", () => {
    expect(Guard).toBeDefined()
    expect(GuardDenied).toBeDefined()
    expect(rules).toBeDefined()
    expect(registerAdapter).toBeDefined()
  })

  it("exposes rule namespaces", () => {
    expect(rules.sql.denyDDL).toBeTypeOf("function")
    expect(rules.sql.denyMutationWithoutWhere).toBeTypeOf("function")
    expect(rules.sql.denyTables).toBeTypeOf("function")
    expect(rules.http.denyHosts).toBeTypeOf("function")
    expect(rules.http.allowHosts).toBeTypeOf("function")
    expect(rules.shell.denyCommands).toBeTypeOf("function")
    expect(rules.fs.confineTo).toBeTypeOf("function")
    expect(rules.custom).toBeTypeOf("function")
  })

  it("exposes typed custom rule helpers per adapter", () => {
    expect(rules.sql.custom).toBeTypeOf("function")
    expect(rules.http.custom).toBeTypeOf("function")
    expect(rules.shell.custom).toBeTypeOf("function")
    expect(rules.fs.custom).toBeTypeOf("function")
  })

  it("exports silentSink", () => {
    expect(silentSink).toBeTypeOf("function")
    expect(silentSink({} as never)).toBeUndefined()
  })

  it("exports SqlParams type — mutable, no undefined element", () => {
    const params: SqlParams = ["a", 1, true, null, new Date(), Buffer.from("x")]
    params.push(2) // mutability check — pre-v0.4 was ReadonlyArray
    expect(params).toHaveLength(7)
  })

  it("rules.http.SSRF_DEFAULTS is a non-empty frozen array", () => {
    expect(Array.isArray(rules.http.SSRF_DEFAULTS)).toBe(true)
    expect(rules.http.SSRF_DEFAULTS.length).toBeGreaterThan(0)
    expect(Object.isFrozen(rules.http.SSRF_DEFAULTS)).toBe(true)
  })
})

describe("end-to-end Guard with rule namespace", () => {
  it("denies DROP TABLE through the public API", () => {
    const guard = new Guard({ rules: [rules.sql.denyDDL()] })
    const tool = guard.tool<{ query: string }, void>("db.query", {
      adapter: "sql.postgres",
      handler: async () => undefined,
    })
    return expect(tool({ query: "DROP TABLE users" })).rejects.toBeInstanceOf(GuardDenied)
  })
})
