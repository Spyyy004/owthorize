import path from "node:path"
import type { FsParsed } from "../adapters/types"
import { deny } from "../decision"
import { makeTypedCustom } from "./_typed-custom"
import type { Rule } from "./types"

export const custom = makeTypedCustom<FsParsed>("fs")

interface ConfineToOptions {
  caseInsensitive?: boolean
}

export function confineTo(roots: readonly string[], opts: ConfineToOptions = {}): Rule {
  if (!roots || roots.length === 0) {
    throw new Error("fs.confineTo: roots list must not be empty")
  }

  const impl = process.platform === "win32" ? path.win32 : path.posix
  const sep = impl.sep
  const caseInsensitive = opts.caseInsensitive ?? process.platform !== "linux"

  const resolved = new Set<string>()
  for (const r of roots) {
    if (typeof r !== "string" || !r.trim()) {
      throw new Error(`fs.confineTo: invalid root: ${String(r)}`)
    }
    let abs = impl.resolve(r)
    if (!abs.endsWith(sep)) abs = abs + sep
    resolved.add(caseInsensitive ? abs.toLowerCase() : abs)
  }
  const rootList = [...resolved]

  return {
    name: "fs.confineTo",
    kind: "builtin",
    evaluate(ctx) {
      const parsed = ctx.parsed
      if (parsed.type !== "fs") return

      let candidate = parsed.absolutePath
      if (!candidate.endsWith(sep)) candidate = candidate + sep
      if (caseInsensitive) candidate = candidate.toLowerCase()

      for (const root of rootList) {
        if (candidate.startsWith(root)) return
      }

      const isWrite = parsed.operation === "write" || parsed.operation === "delete"
      return deny(`path outside confined roots: ${parsed.absolutePath}`, "fs.confineTo", {
        irreversible: isWrite,
      })
    },
  }
}
