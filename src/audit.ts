import type { ParsedAction } from "./adapters/types"
import type { Decision } from "./decision"
import { hashPayload } from "./util/hash"
import { redactPaths } from "./util/redact"

export type AuditRecord = {
  ts: string
  tool: string
  adapter: string | null
  parsed: ParsedAction | null
  /** Format: `sha256:<64-char hex>`. Stable across redacted payloads with identical safe content. */
  payload_hash: string
  decision: "allow" | "deny"
  matched_rule: string | null
  matched_rule_kind: "builtin" | "custom-local" | null
  reason: string | null
  /** True when the denied action was tagged irreversible (DDL, unbounded mutations, destructive shell, write outside fs root). */
  irreversible: boolean
  simulated: boolean
  agent_id?: string
  trace_id?: string
}

export type AuditSink = (record: AuditRecord) => void | Promise<void>

export type OnLogError = "continue" | "throw"

export interface AuditOptions {
  sink?: AuditSink
  fallbackSink?: AuditSink
  onLogError?: OnLogError
}

const defaultSink: AuditSink = (r) => {
  console.log(JSON.stringify(r))
}

const defaultFallbackSink: AuditSink = (r) => {
  console.error("[owthorize:audit-fallback]", JSON.stringify(r))
}

export const silentSink: AuditSink = () => undefined

export class Audit {
  private readonly sink: AuditSink
  private readonly fallbackSink: AuditSink
  private readonly onLogError: OnLogError

  constructor(opts: AuditOptions = {}) {
    this.sink = opts.sink ?? defaultSink
    this.fallbackSink = opts.fallbackSink ?? defaultFallbackSink
    this.onLogError = opts.onLogError ?? "continue"
  }

  write(input: {
    tool: string
    adapter: string | null
    parsed: ParsedAction | null
    payload: unknown
    redact?: string[]
    decision: Decision
    ruleKind?: "builtin" | "custom-local"
    simulated?: boolean
    agentId?: string
    traceId?: string
  }): void {
    const safePayload = redactPaths(input.payload, input.redact ?? [])
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      tool: input.tool,
      adapter: input.adapter,
      parsed: input.parsed,
      payload_hash: hashPayload(safePayload),
      decision: input.decision.decision,
      matched_rule: input.decision.decision === "deny" ? input.decision.matched : null,
      matched_rule_kind: input.decision.decision === "deny" ? (input.ruleKind ?? "builtin") : null,
      reason: input.decision.decision === "deny" ? input.decision.reason : null,
      irreversible:
        input.decision.decision === "deny" ? (input.decision.irreversible ?? false) : false,
      simulated: input.simulated ?? false,
      ...(input.agentId !== undefined ? { agent_id: input.agentId } : {}),
      ...(input.traceId !== undefined ? { trace_id: input.traceId } : {}),
    }
    try {
      const result = this.sink(record)
      if (result instanceof Promise) {
        result.catch(() => this.fallback(record))
      }
    } catch (err) {
      if (this.onLogError === "throw") throw err
      this.fallback(record)
    }
  }

  private fallback(record: AuditRecord): void {
    try {
      this.fallbackSink(record)
    } catch {
      // give up; never let audit failure break execution
    }
  }
}
