import path from "node:path"
import type { ShellParsed } from "../adapters/types"
import { deny } from "../decision"
import { makeTypedCustom } from "./_typed-custom"
import type { Rule } from "./types"

export const custom = makeTypedCustom<ShellParsed>("shell")

/**
 * Built-in destructive command set used to decide whether a `denyCommands`
 * match is tagged `irreversible: true`. Override per-rule via the `destructive`
 * option (pass `[]` to disable irreversible flagging entirely on this rule).
 */
export const DESTRUCTIVE_DEFAULTS: readonly string[] = Object.freeze([
  "rm",
  "rmdir",
  "shred",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "wipefs",
  "blkdiscard",
  "format",
])

interface DenyCommandsOptions {
  allowMetachar?: boolean
  caseSensitive?: boolean
  /**
   * Subset of the deny list whose matches are tagged `irreversible: true`.
   * Defaults to `DESTRUCTIVE_DEFAULTS` (commands like `rm`, `dd`, `mkfs`).
   * Pass `[]` to disable irreversible flagging on this rule.
   */
  destructive?: readonly string[]
}

export function denyCommands(commands: readonly string[], opts: DenyCommandsOptions = {}): Rule {
  if (!commands || commands.length === 0) {
    throw new Error("shell.denyCommands: command list must not be empty")
  }
  const caseSensitive = opts.caseSensitive ?? false
  const denySet = new Set<string>()
  for (const c of commands) {
    if (typeof c !== "string" || !c.trim()) {
      throw new Error(`shell.denyCommands: invalid command entry: ${String(c)}`)
    }
    denySet.add(normalizeCommand(c, caseSensitive))
  }

  const destructiveSrc = opts.destructive ?? DESTRUCTIVE_DEFAULTS
  const destructiveSet = new Set<string>(
    destructiveSrc.map((c) => normalizeCommand(c, caseSensitive)),
  )

  return {
    name: "shell.denyCommands",
    kind: "builtin",
    evaluate(ctx) {
      const parsed = ctx.parsed
      if (parsed.type !== "shell") return

      if (!opts.allowMetachar) {
        if (parsed.hasSubstitution) {
          return deny("shell command-substitution not allowed", "shell.metachar")
        }
        if (parsed.hasPipe) {
          return deny("shell pipe not allowed", "shell.metachar")
        }
        if (parsed.hasRedirect) {
          return deny("shell redirect not allowed", "shell.metachar")
        }
        if (parsed.hasMetachar) {
          return deny("shell metacharacter not allowed", "shell.metachar")
        }
      }

      if (parsed.command === null) return

      const basename = normalizeCommand(parsed.command, caseSensitive)
      if (denySet.has(basename)) {
        return deny(`shell command not allowed: ${basename}`, "shell.denyCommands", {
          irreversible: destructiveSet.has(basename),
        })
      }
    },
  }
}

function normalizeCommand(c: string, caseSensitive: boolean): string {
  let base = path.posix.basename(c.replace(/\\/g, "/"))
  if (base.toLowerCase().endsWith(".exe")) base = base.slice(0, -4)
  return caseSensitive ? base : base.toLowerCase()
}
