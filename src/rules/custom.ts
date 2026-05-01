import { type Decision, deny } from "../decision"
import { hashPayload } from "../util/hash"
import type { Rule, RuleContext } from "./types"

interface CustomRuleSpec {
  name?: string
  on?: string | string[]
  when: (ctx: RuleContext) => unknown
  decide: (ctx: RuleContext) => Decision | void
}

export function custom(spec: CustomRuleSpec): Rule {
  if (!spec || typeof spec.when !== "function" || typeof spec.decide !== "function") {
    throw new Error("rules.custom: spec must include `when` and `decide` functions")
  }

  const name = spec.name ?? autoName(spec.when, spec.decide)

  return {
    name,
    kind: "custom-local",
    on: spec.on,
    evaluate(ctx) {
      const matched = spec.when(ctx)
      if (isThenable(matched)) {
        throw new Error(`rules.custom(${name}): \`when\` must be synchronous`)
      }
      if (!matched) return

      const decision = spec.decide(ctx)
      if (isThenable(decision)) {
        throw new Error(`rules.custom(${name}): \`decide\` must be synchronous`)
      }
      if (!decision || decision.decision === "allow") return
      if (decision.decision === "deny") {
        return deny(decision.reason ?? "denied by custom rule", decision.matched ?? name, {
          irreversible: decision.irreversible,
        })
      }
      throw new Error(`rules.custom(${name}): \`decide\` returned an invalid Decision shape`)
    },
  }
}

function isThenable(v: unknown): boolean {
  return (
    !!v &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  )
}

function autoName(when: unknown, decide: unknown): string {
  const sig = `${String(when)}::${String(decide)}`
  return `custom-local:${hashPayload(sig).slice(0, 24)}`
}
