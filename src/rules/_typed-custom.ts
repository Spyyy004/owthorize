import type { ParsedAction } from "../adapters/types"
import type { Decision } from "../decision"
import { custom as baseCustom } from "./custom"
import type { Rule, RuleContext } from "./types"

type ContextOf<T extends ParsedAction> = Omit<RuleContext, "parsed"> & { parsed: T }

export interface TypedCustomSpec<T extends ParsedAction> {
  name?: string
  on?: string | string[]
  when: (ctx: ContextOf<T>) => unknown
  decide: (ctx: ContextOf<T>) => Decision | void
}

export function makeTypedCustom<T extends ParsedAction>(parsedType: T["type"]) {
  return (spec: TypedCustomSpec<T>): Rule =>
    baseCustom({
      name: spec.name,
      on: spec.on,
      when: (ctx) => {
        if (ctx.parsed.type !== parsedType) return false
        return spec.when(ctx as ContextOf<T>)
      },
      decide: (ctx) => {
        if (ctx.parsed.type !== parsedType) return
        return spec.decide(ctx as ContextOf<T>)
      },
    })
}
