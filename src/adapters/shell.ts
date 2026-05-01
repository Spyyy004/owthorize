import { parse as shellParse } from "shell-quote"
import { registerAdapter } from "./registry"
import type { Adapter, ShellParsed } from "./types"

interface ShellPayload {
  command?: string
  argv?: string[]
}

function isShellPayload(p: unknown): p is ShellPayload {
  if (typeof p !== "object" || p === null) return false
  const c = (p as { command?: unknown }).command
  const a = (p as { argv?: unknown }).argv
  if (c !== undefined && typeof c !== "string") return false
  if (a !== undefined && !Array.isArray(a)) return false
  return c !== undefined || a !== undefined
}

const PIPE_OPS = new Set(["|", "||"])
const REDIRECT_OPS = new Set([">", ">>", "<", "<<", "<<<", "&>", "&>>"])
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

export function makeShellAdapter(): Adapter {
  return {
    name: "shell",
    parse(payload): ShellParsed {
      if (!isShellPayload(payload)) {
        throw new Error(
          "shell adapter: payload must include { command: string } or { argv: string[] }",
        )
      }

      if (payload.argv !== undefined) {
        const argv = payload.argv.map((x) => String(x))
        if (argv.length === 0 || !argv[0].trim()) {
          throw new Error("shell adapter: empty argv")
        }
        return {
          type: "shell",
          command: extractCommand(argv),
          argv,
          hasPipe: false,
          hasRedirect: false,
          hasSubstitution: false,
          hasMetachar: false,
          raw: argv.join(" "),
        }
      }

      const raw = String(payload.command ?? "")
      if (!raw.trim()) {
        throw new Error("shell adapter: empty command")
      }

      const tokens = shellParse(raw, {})
      const argv: string[] = []
      let hasPipe = false
      let hasRedirect = false
      let hasOtherOp = false

      for (const tok of tokens) {
        if (typeof tok === "string") {
          argv.push(tok)
          continue
        }
        if (typeof tok === "object" && tok !== null && "op" in tok) {
          const op = String((tok as { op: string }).op)
          if (PIPE_OPS.has(op)) hasPipe = true
          else if (REDIRECT_OPS.has(op)) hasRedirect = true
          else hasOtherOp = true
        }
      }

      const hasSubstitution = /`|\$\(/.test(raw)
      const hasMetachar = hasPipe || hasRedirect || hasSubstitution || hasOtherOp

      return {
        type: "shell",
        command: extractCommand(argv),
        argv,
        hasPipe,
        hasRedirect,
        hasSubstitution,
        hasMetachar,
        raw,
      }
    },
  }
}

function extractCommand(argv: string[]): string | null {
  for (const a of argv) {
    if (ENV_ASSIGN.test(a)) continue
    return a
  }
  return null
}

registerAdapter(makeShellAdapter())
