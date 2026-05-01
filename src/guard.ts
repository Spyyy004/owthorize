import { getAdapter } from "./adapters"
import type { ParsedAction } from "./adapters/types"
import { Audit, type AuditOptions, type OnLogError } from "./audit"
import { type Decision, GuardDenied, deny } from "./decision"
import type { Rule, RuleKind } from "./rules/types"

export type FailurePolicy = "deny" | "allow"

export interface GuardDefaults {
  onUnknownTool?: FailurePolicy
  onRuleError?: FailurePolicy
  onAdapterError?: FailurePolicy
  onLogError?: OnLogError
}

export interface GuardOptions {
  rules?: Rule[]
  defaults?: GuardDefaults
  audit?: AuditOptions
}

export interface ToolOptions<I, O> {
  adapter?: string
  handler: (input: I) => Promise<O> | O
  redact?: string[]
}

interface RegisteredTool {
  name: string
  adapter: string | undefined
  handler: (input: unknown) => unknown
  redact: string[]
}

const DEFAULTS: Required<GuardDefaults> = {
  onUnknownTool: "deny",
  onRuleError: "deny",
  onAdapterError: "deny",
  onLogError: "continue",
}

export class Guard {
  private readonly rules: Rule[]
  private readonly defaults: Required<GuardDefaults>
  private readonly audit: Audit
  private readonly tools = new Map<string, RegisteredTool>()

  constructor(opts: GuardOptions = {}) {
    this.rules = opts.rules ?? []
    this.defaults = { ...DEFAULTS, ...opts.defaults }
    this.audit = new Audit({ ...opts.audit, onLogError: this.defaults.onLogError })
  }

  addRule(rule: Rule): void {
    this.rules.push(rule)
  }

  tool<I, O>(name: string, opts: ToolOptions<I, O>): (input: I) => Promise<O> {
    if (this.tools.has(name)) {
      throw new Error(`[owthorize] tool already registered: ${name}`)
    }
    const reg: RegisteredTool = {
      name,
      adapter: opts.adapter,
      handler: opts.handler as (input: unknown) => unknown,
      redact: opts.redact ?? [],
    }
    this.tools.set(name, reg)

    return async (input: I): Promise<O> => {
      const decision = this.evaluate({
        tool: name,
        payload: input,
        simulated: false,
        registered: reg,
      })
      if (decision.decision === "deny") {
        throw new GuardDenied({
          tool: name,
          reason: decision.reason,
          matched: decision.matched,
          irreversible: decision.irreversible ?? false,
        })
      }
      return await opts.handler(input)
    }
  }

  async check(input: { tool: string; payload: unknown }): Promise<Decision> {
    return this.evaluate({ tool: input.tool, payload: input.payload, simulated: false })
  }

  simulate(tool: string, payload: unknown): Decision {
    return this.evaluate({ tool, payload, simulated: true })
  }

  private evaluate(args: {
    tool: string
    payload: unknown
    simulated: boolean
    registered?: RegisteredTool
  }): Decision {
    const reg = args.registered ?? this.tools.get(args.tool)

    if (!reg) {
      const decision: Decision =
        this.defaults.onUnknownTool === "allow"
          ? { decision: "allow" }
          : deny(`unknown tool: ${args.tool}`, "owthorize.unknownTool")
      this.audit.write({
        tool: args.tool,
        adapter: null,
        parsed: null,
        payload: args.payload,
        decision,
        simulated: args.simulated,
      })
      return decision
    }

    const adapterName = reg.adapter ?? "raw"
    let parsed: ParsedAction
    try {
      parsed = getAdapter(adapterName).parse(args.payload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const decision: Decision =
        this.defaults.onAdapterError === "allow"
          ? { decision: "allow" }
          : deny(`adapter error: ${msg}`, "owthorize.adapterError")
      this.audit.write({
        tool: args.tool,
        adapter: adapterName,
        parsed: null,
        payload: args.payload,
        redact: reg.redact,
        decision,
        simulated: args.simulated,
      })
      return decision
    }

    let chosen: { decision: Decision; ruleKind: RuleKind } | null = null
    for (const rule of this.rules) {
      if (rule.on && !matchesOn(rule.on, args.tool)) continue
      let r: Decision | void
      try {
        r = rule.evaluate({ tool: args.tool, parsed, payload: args.payload })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const decision: Decision =
          this.defaults.onRuleError === "allow"
            ? { decision: "allow" }
            : deny(`rule error in ${rule.name}: ${msg}`, `owthorize.ruleError:${rule.name}`)
        this.audit.write({
          tool: args.tool,
          adapter: adapterName,
          parsed,
          payload: args.payload,
          redact: reg.redact,
          decision,
          ruleKind: rule.kind ?? "builtin",
          simulated: args.simulated,
        })
        return decision
      }
      if (r && r.decision === "deny") {
        chosen = { decision: r, ruleKind: rule.kind ?? "builtin" }
        break
      }
    }

    const decision: Decision = chosen?.decision ?? { decision: "allow" }
    this.audit.write({
      tool: args.tool,
      adapter: adapterName,
      parsed,
      payload: args.payload,
      redact: reg.redact,
      decision,
      ruleKind: chosen?.ruleKind ?? "builtin",
      simulated: args.simulated,
    })
    return decision
  }
}

function matchesOn(on: string | string[], tool: string): boolean {
  if (typeof on === "string") return on === tool
  return on.includes(tool)
}
