import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import type { SqlParsed } from "../../src/adapters/types"

const pg = getAdapter("sql.postgres")
const mysql = getAdapter("sql.mysql")
const sqlite = getAdapter("sql.sqlite")

const parse = (a: typeof pg, q: string): SqlParsed => a.parse({ query: q }) as SqlParsed

describe("sql.postgres adapter", () => {
  it("parses SELECT with WHERE", () => {
    const p = parse(pg, "SELECT * FROM users WHERE id = 1")
    expect(p.type).toBe("sql")
    expect(p.dialect).toBe("postgres")
    expect(p.kind).toBe("select")
    expect(p.tables).toContain("users")
    expect(p.hasWhere).toBe(true)
  })

  it("flags UPDATE without WHERE", () => {
    const p = parse(pg, "UPDATE users SET active = false")
    expect(p.kind).toBe("update")
    expect(p.hasWhere).toBe(false)
  })

  it("flags UPDATE with WHERE", () => {
    const p = parse(pg, "UPDATE users SET active = false WHERE id = 1")
    expect(p.kind).toBe("update")
    expect(p.hasWhere).toBe(true)
  })

  it("flags DELETE without WHERE", () => {
    const p = parse(pg, "DELETE FROM users")
    expect(p.kind).toBe("delete")
    expect(p.hasWhere).toBe(false)
    expect(p.tables).toContain("users")
  })

  it("flags DELETE with WHERE", () => {
    const p = parse(pg, "DELETE FROM users WHERE id = 1")
    expect(p.kind).toBe("delete")
    expect(p.hasWhere).toBe(true)
  })

  it("identifies DROP TABLE", () => {
    const p = parse(pg, "DROP TABLE users")
    expect(p.kind).toBe("ddl")
    expect(p.ddlOp).toBe("drop")
    expect(p.tables).toContain("users")
  })

  it("identifies TRUNCATE", () => {
    const p = parse(pg, "TRUNCATE TABLE users")
    expect(p.kind).toBe("ddl")
    expect(p.ddlOp).toBe("truncate")
  })

  it("identifies ALTER TABLE", () => {
    const p = parse(pg, "ALTER TABLE users ADD COLUMN x INT")
    expect(p.kind).toBe("ddl")
    expect(p.ddlOp).toBe("alter")
  })

  it("identifies CREATE TABLE", () => {
    const p = parse(pg, "CREATE TABLE x (id INT)")
    expect(p.kind).toBe("ddl")
    expect(p.ddlOp).toBe("create")
  })

  it("identifies INSERT", () => {
    const p = parse(pg, "INSERT INTO users (name) VALUES ('a')")
    expect(p.kind).toBe("insert")
    expect(p.tables).toContain("users")
  })

  it("flags hasLimit", () => {
    const p = parse(pg, "SELECT * FROM users LIMIT 10")
    expect(p.hasLimit).toBe(true)
  })

  it("captures multiple tables across joins and subqueries", () => {
    const p = parse(
      pg,
      "SELECT * FROM users u JOIN posts p ON u.id = p.user_id WHERE u.id IN (SELECT user_id FROM bans)",
    )
    expect(p.tables).toEqual(expect.arrayContaining(["users", "posts", "bans"]))
  })

  it("throws on invalid SQL", () => {
    expect(() => parse(pg, "this is not sql at all !!!")).toThrow()
  })

  it("throws on empty query", () => {
    expect(() => parse(pg, "   ")).toThrow(/empty query/)
  })

  it("throws when payload missing query", () => {
    expect(() => pg.parse({})).toThrow(/query: string/)
  })

  it("DDL takes precedence in mixed multi-statement", () => {
    const p = parse(pg, "SELECT 1; DROP TABLE x;")
    expect(p.kind).toBe("ddl")
    expect(p.ddlOp).toBe("drop")
  })
})

describe("sql.mysql adapter", () => {
  it("parses MySQL-specific LIMIT offset, count", () => {
    const p = parse(mysql, "SELECT * FROM users LIMIT 5, 10")
    expect(p.kind).toBe("select")
    expect(p.hasLimit).toBe(true)
  })
})

describe("sql.sqlite adapter", () => {
  it("parses simple sqlite SELECT", () => {
    const p = parse(sqlite, "SELECT 1")
    expect(p.kind).toBe("select")
  })
})
