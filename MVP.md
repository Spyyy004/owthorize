# Agent Guard SDK — MVP Spec

An SDK that sits at the tooling layer of AI agents and blocks unsafe tool calls before they produce side effects.

---

## Premise

Agents call tools. Tools have side effects. The SDK is the gate that every tool call passes through inside the developer's process. The developer opts in by registering their tools through the SDK — that is the trust boundary, and the spec is honest about it.

---

## Threat model

**Catches**
- Prompt-injected tool calls
- Hallucinated arguments
- Agent reasoning errors
- Classes of unsafe shapes: DDL, unbounded `DELETE` / `UPDATE`, SSRF targets, shell metacharacters, path traversal

**Does not catch**
- A malicious agent runtime that bypasses the registry
- Vulnerabilities inside the underlying tool implementation
- Side effects that occur before the tool boundary

If the customer needs defense against a hostile runtime, they need a process boundary (proxy, sidecar, container egress rules). That is a different product and this SDK does not pretend to be it.

---

## Design principles

1. **Synchronous v1.** Allow or deny, return immediately. No approvals, no webhooks, no async resume. Approvals are a v2 product with their own infrastructure (state store, callback URLs, idempotency); bolting them on now would deform v1.
2. **Parse, don't match.** Built-in rules use real parsers (SQL AST, URL, shell tokens, normalized paths). Regex on SQL is a defect generator.
3. **Adapters normalize, rules decide.** The rule engine never sees raw payloads. Adapters convert tool inputs into a typed `ParsedAction`. Rules are written against parsed shapes — portable, testable, and friendly to a future hosted mode.
4. **Wrap once at the tool layer.** Primary API is `guard.tool(name, handler)`. Developers do not write `if (decision.status === "allow")` branches.
5. **Default deny on uncertainty.** Unknown tool → deny. Rule throws → deny. Adapter cannot parse → deny. Log write fails → continue. Each is configurable; defaults bias safe.
6. **Testable from day one.** `guard.simulate(tool, payload)` returns a decision with no side effects. Rules ship with unit tests.

---

## v1 scope

### 1. Tool wrapper

```ts
const safeQuery = guard.tool("db.query", {
  adapter: "sql.postgres",
  handler: async ({ query, params }) => db.query(query, params),
})
```

`safeQuery` is a drop-in for the original handler. On deny it throws `GuardDenied` with a structured reason. The agent framework sees a tool error — the path it already handles.

### 2. Adapters

Ship four. Each takes a raw payload and produces a `ParsedAction`.

| Adapter | Parses into |
|---|---|
| `sql.postgres` / `sql.mysql` / `sql.sqlite` | statement kind, target tables, presence of `WHERE`, heuristic row scope |
| `http` | method, URL parts (host, path, port), header keys, body size |
| `shell` | argv, expanded redirections, detected metacharacters |
| `fs` | normalized absolute path, operation kind (read / write / delete) |

Adapters are the contract. Rules are written against parsed shapes, not strings.

### 3. Built-in rule library

The rules a developer needs on day one:

```ts
rules.sql.denyDDL()                            // DROP, TRUNCATE, ALTER, CREATE
rules.sql.denyMutationWithoutWhere()           // UPDATE / DELETE with no WHERE
rules.sql.denyTables({ deny: ["audit_log"] }) // append-only protection

rules.http.denyHosts(rules.http.SSRF_DEFAULTS) // 169.254.169.254, localhost, RFC1918, *.internal
rules.http.allowHosts(["api.stripe.com", "api.openai.com"])

rules.shell.denyCommands(["rm", "curl", "wget", "nc", "ssh"])

rules.fs.confineTo(["/tmp/agent-workspace"])   // blocks path traversal
```

If a developer cannot get value from the built-ins in 10 minutes, the SDK has failed.

### 4. Custom rules (declarative-first)

```ts
rules.custom({
  on: "db.query",
  when: ({ parsed }) => parsed.kind === "delete" && parsed.tables.includes("users"),
  decide: () => ({ decision: "deny", reason: "users table is protected" }),
})
```

`when` is a predicate, `decide` returns the verdict. Closures are allowed but flagged in logs as `local-only` so a future hosted mode can refuse to evaluate them.

### 5. Audit log

Every check writes one structured record:

```json
{
  "ts": "2026-04-30T12:00:00Z",
  "tool": "db.query",
  "adapter": "sql.postgres",
  "parsed": { "kind": "delete", "tables": ["users"], "hasWhere": false },
  "payload_hash": "sha256:...",
  "decision": "deny",
  "matched_rule": "sql.denyMutationWithoutWhere",
  "reason": "DELETE without WHERE clause",
  "agent_id": "...",
  "trace_id": "..."
}
```

The sink is pluggable (`console`, file, function). Payloads are hashed by default; sensitive fields are redacted via `redact: ["params.password"]` on the tool. Log failure does not block execution but is recorded to a fallback sink.

---

## API surface (complete)

```ts
import { Guard, rules } from "agent-guard"

const guard = new Guard({
  rules: [
    rules.sql.denyDDL(),
    rules.sql.denyMutationWithoutWhere(),
    rules.http.denyHosts(rules.http.SSRF_DEFAULTS),
  ],
  defaults: {
    onUnknownTool: "deny",
    onRuleError: "deny",
    onAdapterError: "deny",
    onLogError: "continue",
  },
  audit: { sink: structuredLogger },
})

// Wrap a tool
const safeQuery = guard.tool("db.query", {
  adapter: "sql.postgres",
  handler: async ({ query, params }) => db.query(query, params),
  redact: ["params.password"],
})

// Test a rule without side effects
const decision = guard.simulate("db.query", { query: "DROP TABLE x" })
// → { decision: "deny", reason: "DDL not allowed", matched: "sql.denyDDL" }

// Low-level escape hatch (rare)
const d = await guard.check({ tool: "db.query", payload: { query } })
```

That is the entire surface: one class, `tool()`, `simulate()`, `check()`, a rule library, a handful of adapters.

### Decision shape

```ts
type Decision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; matched: string }
```

### Failure modes

| Failure | Default | Configurable |
|---|---|---|
| Unknown tool | deny | `defaults.onUnknownTool` |
| Rule throws | deny | `defaults.onRuleError` |
| Adapter cannot parse | deny | `defaults.onAdapterError` |
| Audit sink throws | continue, write to fallback | `defaults.onLogError` |

### Rule precedence

Flat priority: any `deny` wins. No allow / approval / block hierarchy. Allowlist rules deny everything not matched.

---

## Framework integrations (thin shims, not in core)

```ts
import { protectTools } from "agent-guard/openai"
const safeTools = protectTools(guard, openaiToolDefinitions)
```

Same pattern for `agent-guard/anthropic`, `agent-guard/langchain`, `agent-guard/vercel-ai`. Each shim is roughly fifty lines that map the framework's tool-registration call into `guard.tool(...)`.

---

## Explicitly out of scope for v1

- Human-in-the-loop approvals, webhooks, Slack integration
- Hosted policy server, rule sync, multi-tenant control plane
- Anything async beyond the handler itself
- Row-count or cost estimation requiring a live DB connection
- Rule conflict resolution beyond flat priority
- UI for logs

These are real product needs. They are also where the previous spec drowned. v2 picks one based on what design partners actually hit.

---

## Validation bar

A developer can:
1. Install and wrap their existing OpenAI / Anthropic tool registry in under five minutes.
2. Run their agent test suite — built-in rules block at least one previously-unsafe call with no false positives on safe calls.
3. Read the audit log and explain every decision.
4. Write a custom rule with a unit test in under ten minutes.

If those four work, the SDK is real.

---

## Two-week build plan

- **Days 1–2** — Core `Guard`, `tool()`, sync decision flow, `simulate()`, audit log
- **Days 3–5** — SQL adapter (Postgres first), three SQL rules, tests
- **Days 6–7** — HTTP adapter, SSRF rules, allow / deny host lists
- **Days 8–9** — Shell and FS adapters and rules
- **Days 10–11** — OpenAI and Anthropic framework shims, README, runnable example
- **Days 12–14** — Land with a design partner, fix what breaks

---

## Mental model

```
Agent → guard.tool(handler) → adapter → rules → decision
                                                  ├─ allow → run handler
                                                  └─ deny  → throw GuardDenied
```

One gate. One decision. No magic.
