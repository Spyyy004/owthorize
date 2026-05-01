export type SqlKind = "select" | "insert" | "update" | "delete" | "ddl" | "other"
export type SqlDdlOp = "drop" | "truncate" | "alter" | "create" | "rename"

export type SqlParsed = {
  type: "sql"
  dialect: "postgres" | "mysql" | "sqlite"
  kind: SqlKind
  ddlOp?: SqlDdlOp
  tables: string[]
  hasWhere: boolean
  hasLimit: boolean
  raw: string
}

/**
 * Common SQL parameter shape, intentionally mutable and free of `undefined`
 * to interop cleanly with `mysql2`/`pg`/`sqlite3` `execute()` signatures.
 * Pass `null` for SQL `NULL`.
 */
export type SqlParams = Array<string | number | boolean | null | Date | Buffer>

export type HttpParsed = {
  type: "http"
  method: string
  url: string
  host: string
  hostNormalized: string
  port: number | null
  path: string
  query: Record<string, string | string[]>
  headerKeys: string[]
  bodySize: number
}

export type ShellParsed = {
  type: "shell"
  command: string | null
  argv: string[]
  hasPipe: boolean
  hasRedirect: boolean
  hasSubstitution: boolean
  hasMetachar: boolean
  raw: string
}

export type FsOp = "read" | "write" | "delete" | "list"

export type FsParsed = {
  type: "fs"
  absolutePath: string
  operation: FsOp
  raw: { path: string; op?: string }
}

export type RawParsed = {
  type: "raw"
  payload: unknown
}

export type ParsedAction = SqlParsed | HttpParsed | ShellParsed | FsParsed | RawParsed

export interface Adapter {
  name: string
  parse(payload: unknown): ParsedAction
}
