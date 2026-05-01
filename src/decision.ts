import type { ParsedAction } from "./adapters/types"

export type Decision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; matched: string; irreversible?: boolean }

export const ALLOW: Decision = Object.freeze({ decision: "allow" }) as Decision

export interface DenyOptions {
  irreversible?: boolean
}

export function deny(reason: string, matched: string, options?: DenyOptions): Decision {
  if (options?.irreversible) {
    return { decision: "deny", reason, matched, irreversible: true }
  }
  return { decision: "deny", reason, matched }
}

export class GuardDenied extends Error {
  readonly tool: string
  readonly reason: string
  readonly matched: string
  readonly irreversible: boolean
  readonly parsed: ParsedAction | undefined

  constructor(args: {
    tool: string
    reason: string
    matched: string
    irreversible?: boolean
    parsed?: ParsedAction
  }) {
    super(`[owthorize] ${args.tool}: ${args.reason} (matched: ${args.matched})`)
    this.name = "GuardDenied"
    this.tool = args.tool
    this.reason = args.reason
    this.matched = args.matched
    this.irreversible = args.irreversible ?? false
    this.parsed = args.parsed
  }
}
