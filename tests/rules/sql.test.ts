import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import type { SqlParsed } from "../../src/adapters/types"
import { type Decision, deny } from "../../src/decision"
import { custom, denyDDL, denyMutationWithoutWhere, denyTables } from "../../src/rules/sql"
import type { Rule, RuleContext } from "../../src/rules/types"

const pg = getAdapter("sql.postgres")
const raw = getAdapter("raw")

const ctxFor = (rule: Rule, query: string, tool = "db.query"): RuleContext => ({
  tool,
  parsed: pg.parse({ query }) as SqlParsed,
  payload: { query },
})

const run = (rule: Rule, query: string): Decision | void => rule.evaluate(ctxFor(rule, query))

describe("sql.denyDDL", () => {
  const rule = denyDDL()

  it("denies DROP TABLE", () => {
    const d = run(rule, "DROP TABLE users") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("sql.denyDDL")
  })

  it("denies TRUNCATE", () => {
    const d = run(rule, "TRUNCATE TABLE users") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("denies ALTER", () => {
    const d = run(rule, "ALTER TABLE users ADD COLUMN x INT") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("denies CREATE", () => {
    const d = run(rule, "CREATE TABLE x (id INT)") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("includes the offending op in the reason", () => {
    const d = run(rule, "DROP TABLE users") as Decision
    if (d?.decision === "deny") expect(d.reason).toMatch(/drop/i)
  })

  it("allows SELECT", () => {
    expect(run(rule, "SELECT 1")).toBeUndefined()
  })

  it("allows INSERT", () => {
    expect(run(rule, "INSERT INTO users (name) VALUES ('a')")).toBeUndefined()
  })

  it("ignores non-SQL parsed actions", () => {
    const d = rule.evaluate({
      tool: "x",
      parsed: raw.parse({ anything: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })

  it("has builtin kind and stable name", () => {
    expect(rule.name).toBe("sql.denyDDL")
    expect(rule.kind).toBe("builtin")
  })

  it("flags DDL denials as irreversible", () => {
    const d = run(rule, "DROP TABLE users") as Decision
    if (d?.decision === "deny") expect(d.irreversible).toBe(true)
  })
})

describe("sql.denyMutationWithoutWhere", () => {
  const rule = denyMutationWithoutWhere()

  it("denies DELETE without WHERE", () => {
    const d = run(rule, "DELETE FROM users") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("sql.denyMutationWithoutWhere")
  })

  it("allows DELETE with WHERE", () => {
    expect(run(rule, "DELETE FROM users WHERE id = 1")).toBeUndefined()
  })

  it("denies UPDATE without WHERE", () => {
    const d = run(rule, "UPDATE users SET active = false") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("allows UPDATE with WHERE", () => {
    expect(run(rule, "UPDATE users SET active = false WHERE id = 1")).toBeUndefined()
  })

  it("ignores SELECT", () => {
    expect(run(rule, "SELECT * FROM users")).toBeUndefined()
  })

  it("ignores INSERT", () => {
    expect(run(rule, "INSERT INTO users (name) VALUES ('a')")).toBeUndefined()
  })

  it("does not fire on TRUNCATE (handled by denyDDL)", () => {
    expect(run(rule, "TRUNCATE TABLE users")).toBeUndefined()
  })

  it("includes table name in the reason", () => {
    const d = run(rule, "DELETE FROM customers") as Decision
    if (d?.decision === "deny") expect(d.reason).toMatch(/customers/)
  })

  it("flags unbounded mutation denials as irreversible", () => {
    const d = run(rule, "DELETE FROM users") as Decision
    if (d?.decision === "deny") expect(d.irreversible).toBe(true)
  })
})

describe("sql.denyTables", () => {
  it("throws if neither deny nor allow is provided", () => {
    expect(() => denyTables({})).toThrow(/deny.*allow/)
  })

  it("denies a listed table", () => {
    const rule = denyTables({ deny: ["audit_log"] })
    const d = run(rule, "INSERT INTO audit_log (event) VALUES ('x')") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.reason).toMatch(/audit_log/)
  })

  it("allows tables not on the deny list", () => {
    const rule = denyTables({ deny: ["audit_log"] })
    expect(run(rule, "SELECT * FROM users")).toBeUndefined()
  })

  it("matches case-insensitively", () => {
    const rule = denyTables({ deny: ["AUDIT_LOG"] })
    const d = run(rule, "DELETE FROM audit_log WHERE id = 1") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("strips schema qualifier from configured table", () => {
    const rule = denyTables({ deny: ["public.audit_log"] })
    const d = run(rule, "DELETE FROM audit_log WHERE id = 1") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("allowlist denies a table not in the allowlist", () => {
    const rule = denyTables({ allow: ["users"] })
    const d = run(rule, "SELECT * FROM admins") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.reason).toMatch(/admins/)
  })

  it("allowlist allows a table that is in the allowlist", () => {
    const rule = denyTables({ allow: ["users"] })
    expect(run(rule, "SELECT * FROM users WHERE id = 1")).toBeUndefined()
  })

  it("deny takes precedence over allow when both supplied", () => {
    const rule = denyTables({ deny: ["audit_log"], allow: ["audit_log", "users"] })
    const d = run(rule, "SELECT * FROM audit_log") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("ignores queries without tables (e.g. SELECT 1)", () => {
    const rule = denyTables({ deny: ["users"] })
    expect(run(rule, "SELECT 1")).toBeUndefined()
  })

  it("does not mutate user-supplied arrays", () => {
    const original = ["AUDIT_LOG"]
    denyTables({ deny: original })
    expect(original).toEqual(["AUDIT_LOG"])
  })

  it("ignores non-SQL parsed actions", () => {
    const rule = denyTables({ deny: ["x"] })
    const d = rule.evaluate({
      tool: "y",
      parsed: raw.parse({ x: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })

  it("flags writes to denied tables as irreversible", () => {
    const rule = denyTables({ deny: ["audit_log"] })
    const d = run(rule, "INSERT INTO audit_log (e) VALUES ('x')") as Decision
    if (d?.decision === "deny") expect(d.irreversible).toBe(true)
  })

  it("does NOT flag SELECT against denied table as irreversible", () => {
    const rule = denyTables({ deny: ["audit_log"] })
    const d = run(rule, "SELECT * FROM audit_log WHERE id = 1") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.irreversible).toBeUndefined()
  })
})

describe("sql.custom (typed helper)", () => {
  it("narrows parsed to SqlParsed and fires when predicate matches", () => {
    const rule = custom({
      name: "policy.no_inserts_to_payments",
      on: "db.query",
      when: ({ parsed }) => parsed.kind === "insert" && parsed.tables.includes("payments"),
      decide: ({ parsed }) =>
        deny(`writes to ${parsed.tables.join(",")} blocked`, "policy.no_inserts_to_payments"),
    })
    const d = run(rule, "INSERT INTO payments (id) VALUES (1)") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("policy.no_inserts_to_payments")
  })

  it("does not fire when predicate is false", () => {
    const rule = custom({
      on: "db.query",
      when: ({ parsed }) => parsed.kind === "delete",
      decide: () => deny("blocked", "x"),
    })
    expect(run(rule, "SELECT 1")).toBeUndefined()
  })

  it("skips when parsed.type is not 'sql' (runtime filter)", () => {
    const rule = custom({
      on: "anything",
      when: () => true,
      decide: () => deny("would fire", "x"),
    })
    const d = rule.evaluate({
      tool: "anything",
      parsed: raw.parse({ payload: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })

  it("inherits sync-only enforcement from base custom", () => {
    const rule = custom({
      on: "db.query",
      when: () => Promise.resolve(true) as unknown as boolean,
      decide: () => deny("x", "y"),
    })
    expect(() => rule.evaluate(ctxFor(rule, "SELECT 1"))).toThrow(/synchronous/)
  })
})
