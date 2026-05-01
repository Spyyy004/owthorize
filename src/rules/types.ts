import type { ParsedAction } from "../adapters/types"
import type { Decision } from "../decision"

export type RuleKind = "builtin" | "custom-local"

export interface RuleContext {
  tool: string
  parsed: ParsedAction
  payload: unknown
}

export interface Rule {
  name: string
  kind?: RuleKind
  on?: string | string[]
  evaluate(ctx: RuleContext): Decision | void
}
