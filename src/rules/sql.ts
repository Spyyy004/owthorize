import type { SqlParsed } from "../adapters/types"
import { deny } from "../decision"
import { makeTypedCustom } from "./_typed-custom"
import type { Rule } from "./types"

export const custom = makeTypedCustom<SqlParsed>("sql")

export function denyDDL(): Rule {
  return {
    name: "sql.denyDDL",
    kind: "builtin",
    evaluate(ctx) {
      const parsed = ctx.parsed
      if (parsed.type !== "sql") return
      if (parsed.kind === "ddl") {
        return deny(`DDL not allowed: ${parsed.ddlOp ?? "ddl"}`, "sql.denyDDL", {
          irreversible: true,
        })
      }
    },
  }
}

export function denyMutationWithoutWhere(): Rule {
  return {
    name: "sql.denyMutationWithoutWhere",
    kind: "builtin",
    evaluate(ctx) {
      const parsed = ctx.parsed
      if (parsed.type !== "sql") return
      if ((parsed.kind === "update" || parsed.kind === "delete") && !parsed.hasWhere) {
        const tables = parsed.tables.length ? ` on [${parsed.tables.join(", ")}]` : ""
        return deny(
          `${parsed.kind.toUpperCase()} without WHERE clause${tables}`,
          "sql.denyMutationWithoutWhere",
          { irreversible: true },
        )
      }
    },
  }
}

interface DenyTablesOptions {
  deny?: string[]
  allow?: string[]
}

export function denyTables(opts: DenyTablesOptions): Rule {
  if (!opts || (!opts.deny && !opts.allow)) {
    throw new Error("sql.denyTables: must supply { deny } and/or { allow }")
  }

  const denyList = opts.deny ? new Set(opts.deny.map(normalizeTable)) : null
  const allowList = opts.allow ? new Set(opts.allow.map(normalizeTable)) : null

  return {
    name: "sql.denyTables",
    kind: "builtin",
    evaluate(ctx) {
      const parsed = ctx.parsed
      if (parsed.type !== "sql") return
      if (parsed.tables.length === 0) return

      const tables = parsed.tables.map(normalizeTable)
      const isWrite = parsed.kind !== "select"

      if (denyList) {
        const hit = tables.find((t) => denyList.has(t))
        if (hit) {
          return deny(`access to table not allowed: ${hit}`, "sql.denyTables", {
            irreversible: isWrite,
          })
        }
      }
      if (allowList) {
        const stranger = tables.find((t) => !allowList.has(t))
        if (stranger) {
          return deny(`table not on allowlist: ${stranger}`, "sql.denyTables", {
            irreversible: isWrite,
          })
        }
      }
    },
  }
}

function normalizeTable(name: string): string {
  const lower = name.toLowerCase().trim()
  const dot = lower.lastIndexOf(".")
  return dot === -1 ? lower : lower.slice(dot + 1)
}
