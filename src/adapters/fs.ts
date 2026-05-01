import path from "node:path"
import { registerAdapter } from "./registry"
import type { Adapter, FsOp, FsParsed } from "./types"

interface FsPayload {
  path: string
  op?: string
}

const VALID_OPS = new Set<FsOp>(["read", "write", "delete", "list"])

function isFsPayload(p: unknown): p is FsPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    "path" in p &&
    typeof (p as { path: unknown }).path === "string"
  )
}

function pathImpl(): typeof path.posix | typeof path.win32 {
  return process.platform === "win32" ? path.win32 : path.posix
}

export function makeFsAdapter(): Adapter {
  return {
    name: "fs",
    parse(payload): FsParsed {
      if (!isFsPayload(payload)) {
        throw new Error("fs adapter: payload must include { path: string }")
      }
      const raw = payload.path
      if (!raw.length) {
        throw new Error("fs adapter: empty path")
      }
      if (raw.includes("\0")) {
        throw new Error("fs adapter: NUL byte in path")
      }

      let operation: FsOp = "read"
      if (payload.op !== undefined) {
        if (!VALID_OPS.has(payload.op as FsOp)) {
          throw new Error(`fs adapter: unknown op: ${payload.op}`)
        }
        operation = payload.op as FsOp
      }

      const absolutePath = pathImpl().resolve(raw)

      return {
        type: "fs",
        absolutePath,
        operation,
        raw: payload.op !== undefined ? { path: raw, op: payload.op } : { path: raw },
      }
    },
  }
}

registerAdapter(makeFsAdapter())
