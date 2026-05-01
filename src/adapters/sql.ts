import sqlParser from "node-sql-parser"
import { registerAdapter } from "./registry"
import type { Adapter, SqlDdlOp, SqlKind, SqlParsed } from "./types"

type Dialect = "postgres" | "mysql" | "sqlite"

const parser = new sqlParser.Parser()

const DIALECT_OPT: Record<Dialect, { database: string }> = {
  postgres: { database: "PostgresQL" },
  mysql: { database: "MySQL" },
  sqlite: { database: "SQLite" },
}

interface SqlPayload {
  query: string
  params?: unknown
}

function isSqlPayload(p: unknown): p is SqlPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    "query" in p &&
    typeof (p as { query: unknown }).query === "string"
  )
}

const DDL_OPS: Record<string, SqlDdlOp> = {
  drop: "drop",
  truncate: "truncate",
  alter: "alter",
  create: "create",
  rename: "rename",
}

const KIND_PRECEDENCE: Record<SqlKind, number> = {
  other: 0,
  select: 1,
  insert: 2,
  update: 3,
  delete: 4,
  ddl: 5,
}

export function makeSqlAdapter(dialect: Dialect): Adapter {
  return {
    name: `sql.${dialect}`,
    parse(payload): SqlParsed {
      if (!isSqlPayload(payload)) {
        throw new Error("sql adapter: payload must include { query: string }")
      }
      const raw = payload.query
      if (!raw.trim()) {
        throw new Error("sql adapter: empty query")
      }

      const astResult = parser.astify(raw, DIALECT_OPT[dialect])
      const stmts = Array.isArray(astResult) ? astResult : [astResult]

      let kind: SqlKind = "other"
      let ddlOp: SqlDdlOp | undefined
      const tables = new Set<string>()
      let hasWhere = false
      let hasLimit = false

      for (const stmt of stmts) {
        if (!stmt) continue
        const candidate = classifyKind(stmt)
        if (candidate && KIND_PRECEDENCE[candidate.kind] > KIND_PRECEDENCE[kind]) {
          kind = candidate.kind
          if (candidate.ddlOp && !ddlOp) ddlOp = candidate.ddlOp
        }
        if ((stmt as { where?: unknown }).where != null) hasWhere = true
        if ((stmt as { limit?: unknown }).limit != null) hasLimit = true
        for (const t of extractTables(stmt)) tables.add(t)
      }

      return {
        type: "sql",
        dialect,
        kind,
        ...(ddlOp ? { ddlOp } : {}),
        tables: [...tables],
        hasWhere,
        hasLimit,
        raw,
      }
    },
  }
}

function classifyKind(stmt: unknown): { kind: SqlKind; ddlOp?: SqlDdlOp } | null {
  if (!stmt || typeof stmt !== "object") return null
  const t = String((stmt as { type?: unknown }).type || "").toLowerCase()
  if (t in DDL_OPS) return { kind: "ddl", ddlOp: DDL_OPS[t] }
  if (t === "select") return { kind: "select" }
  if (t === "insert" || t === "replace") return { kind: "insert" }
  if (t === "update") return { kind: "update" }
  if (t === "delete") return { kind: "delete" }
  return { kind: "other" }
}

function extractTables(stmt: unknown): string[] {
  const out: string[] = []
  walk(stmt, (node) => {
    if (
      node !== null &&
      typeof node === "object" &&
      typeof (node as { table?: unknown }).table === "string"
    ) {
      out.push((node as { table: string }).table)
    }
  })
  return out
}

function walk(node: unknown, fn: (n: unknown) => void): void {
  if (node === null || typeof node !== "object") return
  fn(node)
  if (Array.isArray(node)) {
    for (const child of node) walk(child, fn)
    return
  }
  for (const k of Object.keys(node)) {
    walk((node as Record<string, unknown>)[k], fn)
  }
}

registerAdapter(makeSqlAdapter("postgres"))
registerAdapter(makeSqlAdapter("mysql"))
registerAdapter(makeSqlAdapter("sqlite"))
