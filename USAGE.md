# Using `owthorize` — test-drive guide

`owthorize` is a synchronous gate that wraps your AI agent's tools and blocks unsafe calls (SQL DDL, unbounded `DELETE`/`UPDATE`, SSRF targets, shell metacharacters, path traversal) before they execute.

This guide walks through installing the local tarball and wiring it into a real project, with snippets for each framework shim. Pick the section that matches your stack.

---

## 1. Install

You should have received a tarball at `~/Desktop/dummyProject/owthorize/owthorize-0.4.1.tgz` (or wherever you built it). From your project root:

```bash
# npm
npm install /absolute/path/to/owthorize-0.4.1.tgz

# Yarn 2+/4 / PnP — note the package-name@ prefix is required
yarn add owthorize@file:/absolute/path/to/owthorize-0.4.1.tgz

# pnpm
pnpm add file:/absolute/path/to/owthorize-0.4.1.tgz
```

After install, `import { Guard, rules } from "owthorize"` will resolve. Subpath shims resolve too:

- `owthorize/openai`
- `owthorize/anthropic`
- `owthorize/langchain`
- `owthorize/vercel-ai`

Both ESM and CJS are supported. Node ≥ 18.

To pick up a new build later: rebuild & repack in the SDK repo, then `npm install /path/to/tarball.tgz` again. (Or use `npm link` for live edits — `npm link` in the SDK repo, `npm link owthorize` here.)

---

## 2. The model in 30 seconds

```
Your agent → guard.tool(handler) → adapter parses → rules decide
                                                       ├─ allow → handler runs
                                                       └─ deny  → throws GuardDenied
```

- **Adapter** turns the raw payload into a typed `ParsedAction` (SQL AST, parsed URL, tokenized shell, normalized FS path). Pick one when you wrap a tool.
- **Rule** inspects the parsed shape and returns `allow` or `deny`. First deny wins.
- **`GuardDenied`** is a regular `Error` subclass — your existing tool-error handling will see it.

The trust boundary is the wrap. **Tools you don't wrap are not protected.** Default policy denies unknown tools (configurable).

---

## 3. Quickstart (no framework)

```ts
import { Guard, rules, GuardDenied } from "owthorize"

const guard = new Guard({
  rules: [
    rules.sql.denyDDL(),
    rules.sql.denyMutationWithoutWhere(),
    rules.http.denyHosts(rules.http.SSRF_DEFAULTS),
    rules.shell.denyCommands(["rm", "curl", "wget", "nc", "ssh"]),
    rules.fs.confineTo(["/tmp/agent-workspace"]),
  ],
})

const safeQuery = guard.tool<{ query: string }, unknown[]>(
  "db.query",
  {
    adapter: "sql.postgres",
    handler: async ({ query }) => myDb.query(query),
    redact: ["params.password"],
  },
)

try {
  await safeQuery({ query: "DROP TABLE users" })
} catch (err) {
  if (err instanceof GuardDenied) {
    console.log("blocked:", err.matched, err.reason)
  }
}

await safeQuery({ query: "SELECT id FROM users WHERE id = 1" })
// runs the handler
```

That's it. The rest of this guide is variations on this pattern.

---

## 4. Built-in rules

These are the rules you add to `new Guard({ rules: [...] })`. None of them require config beyond what's listed.

| Rule | What it blocks | `matched_rule` value(s) | `irreversible` |
|---|---|---|---|
| `rules.sql.denyDDL()` | `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `RENAME` | `sql.denyDDL` | `true` |
| `rules.sql.denyMutationWithoutWhere()` | `UPDATE` / `DELETE` with no `WHERE` clause | `sql.denyMutationWithoutWhere` | `true` |
| `rules.sql.denyTables({ deny, allow })` | Configured table denylist or allowlist (case-insensitive, schema-stripped) | `sql.denyTables` | `true` for writes, omitted for SELECT |
| `rules.http.denyHosts(list)` | Host literals, IPv4/IPv6 CIDRs, and `*.wildcards` | `http.denyHosts` | omitted |
| `rules.http.allowHosts(list)` | Anything not on the list | `http.allowHosts` | omitted |
| `rules.http.SSRF_DEFAULTS` | Constant: RFC1918, link-local, loopback, AWS metadata, `*.internal`, `*.local` | (constant, not a rule) | — |
| `rules.shell.denyCommands(list, opts?)` | Banned commands (basename match) **and** shell metachar abuse — see note | `shell.denyCommands` (basename match) **or** `shell.metachar` (pipe / redirect / `$()` / backtick / `;` / `&&`) | `true` for `denyCommands`, omitted for `metachar` |
| `rules.fs.confineTo(roots, opts?)` | Anything outside the configured root directories | `fs.confineTo` | `true` for write/delete, omitted for read/list |
| `rules.custom({ on, when, decide })` | Cross-adapter custom rule (untyped `parsed`) | whatever `decide` returns | set by your `decide` |
| `rules.<adapter>.custom({ on, when, decide })` | Typed custom rule — `parsed` is narrowed to that adapter's shape | whatever `decide` returns | set by your `decide` |

> ⚠️ **`hasWhere` is parser-level, not semantic.** `rules.sql.denyMutationWithoutWhere()` lets `DELETE FROM users WHERE 1=1` through. Combine it with `rules.sql.denyTables` (or a typed `rules.sql.custom`) when a destructive call into a specific table needs stronger gating than "any WHERE clause is fine."

> 🔥 **Heads-up on `rules.shell.denyCommands`.** The same rule constructor emits two different `matched_rule` values. Tests that assert on the matched name need to handle both — see the table above.

**Pick `rules.sql.denyTables` over a hand-written allowlist** — it already does case-folding and schema-stripping. Reach for `rules.custom` (or its typed cousins) only when policy is genuinely project-specific.

**The `irreversible` flag.** Built-in rules tag denies that block actions you couldn't easily roll back (DDL, unbounded mutations, destructive shell commands, writes outside fs roots). Your custom rules can set it via `deny(reason, matched, { irreversible: true })`. Consumers route on it — see §10 for the typical pattern (auto-deny vs. surface to a human approval flow).

---

## 5. Pick an adapter

The adapter determines what `parsed` looks like and which rules can apply.

| Adapter | Payload your handler must accept | Rules that work |
|---|---|---|
| `sql.postgres` / `sql.mysql` / `sql.sqlite` | `{ query: string, params?: SqlParams }` | `sql.*` rules |
| `http` | `{ url: string, method?: string, headers?, body? }` | `http.*` rules |
| `shell` | `{ command: string }` or `{ argv: string[] }` | `shell.*` rules |
| `fs` | `{ path: string, op?: "read" \| "write" \| "delete" \| "list" }` | `fs.*` rules |
| `raw` (default if omitted) | anything | `rules.custom` only |

If you don't pass `adapter` when calling `guard.tool()`, you get `raw`, which means your custom rule sees the payload through `ctx.parsed.payload` instead of a typed shape.

**`SqlParams` is exported.** `import type { SqlParams } from "owthorize"` — it's `ReadonlyArray<string | number | boolean | null | Date | Buffer | undefined>`, which lines up with the param shapes accepted by `mysql2`, `pg`, and `sqlite3`. Without it, every consumer ends up casting `(params ?? []) as any[]` to satisfy driver typings.

**Adapter mismatch is the #1 source of confusion.** If your handler takes `{ sql: string }` but you set `adapter: "sql.postgres"`, the adapter will throw because it expects `{ query: string }`. The Guard treats that as "adapter error" and denies (default). Either rename your field or write a thin handler that translates.

**Table identifiers come from the SQL, not your ORM.** `parsed.tables` is `["Product"]` for `SELECT * FROM Product` even if your Drizzle/Prisma schema names that table `products` in JS. When you pass tables to `rules.sql.denyTables` or compare them in `rules.sql.custom`, use the exact identifiers from the rendered SQL (case-sensitive). The casing match is silent if wrong — your custom rule's `decide` will see zero offenders and let the call through.

---

## 6. Framework integrations

Each framework's shim wraps a tool registry once and returns a guarded version.

### 5a. OpenAI SDK (function calling)

```ts
import OpenAI from "openai"
import { Guard, rules } from "owthorize"
import { protectTools } from "owthorize/openai"

const client = new OpenAI()
const guard = new Guard({
  rules: [rules.sql.denyDDL(), rules.http.denyHosts(rules.http.SSRF_DEFAULTS)],
})

const tools = [
  {
    type: "function" as const,
    function: {
      name: "db_query",
      description: "Run a read-only SQL query",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
    handler: async ({ query }: { query: string }) => myDb.query(query),
  },
]

const safeTools = protectTools(guard, tools, {
  db_query: { adapter: "sql.postgres" },
})

// Pass safeTools[i].function to OpenAI; call safeTools[i].handler(args)
// when you receive a tool_call from the model.
```

The shim preserves all OpenAI-specific fields (`strict`, `description`, `parameters`, etc.) and only replaces `handler`.

### 5b. Anthropic SDK

```ts
import Anthropic from "@anthropic-ai/sdk"
import { Guard, rules } from "owthorize"
import { protectTools } from "owthorize/anthropic"

const client = new Anthropic()
const guard = new Guard({
  rules: [rules.sql.denyDDL(), rules.sql.denyMutationWithoutWhere()],
})

const tools = [
  {
    name: "db_query",
    description: "Run a SQL query",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
    handler: async ({ query }: { query: string }) => myDb.query(query),
  },
]

const safeTools = protectTools(guard, tools, {
  db_query: { adapter: "sql.postgres" },
})

// Send safeTools (without handler) to Anthropic; call safeTools[i].handler(args)
// when you receive a tool_use block from the model.
```

### 5c. LangChain JS

```ts
import { Guard, rules } from "owthorize"
import { protectTools } from "owthorize/langchain"

const guard = new Guard({ rules: [rules.sql.denyDDL()] })

const tools = [
  {
    name: "db_query",
    description: "Run a SQL query",
    schema: zodSchema, // your Zod or JSON schema
    func: async ({ query }: { query: string }) => myDb.query(query),
  },
]

const safeTools = protectTools(guard, tools, {
  db_query: { adapter: "sql.postgres" },
})

// Pass safeTools to your LangChain agent (DynamicStructuredTool-shaped).
```

The shim wraps `func` if present, and falls back to `_call` for legacy `Tool` subclasses.

### 5d. Vercel AI SDK

```ts
import { Guard, rules } from "owthorize"
import { protectTools } from "owthorize/vercel-ai"
import { generateText } from "ai"
import { z } from "zod"

const guard = new Guard({ rules: [rules.sql.denyDDL()] })

const tools = {
  db_query: {
    description: "Run a SQL query",
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => myDb.query(query),
  },
}

const safeTools = protectTools(guard, tools, {
  db_query: { adapter: "sql.postgres" },
})

await generateText({ model, tools: safeTools, prompt })
```

Tools without `execute` (client-side tools) pass through untouched.

> ⚠️ **Detecting denies in `result.steps`.** When a wrapped `execute` throws (which is what `GuardDenied` does), Vercel AI surfaces it as a `tool-error` content entry, **not** as a `step.toolResults[]` item. `step.toolResults` only contains successful results. Walk `step.content[]` instead — it's a discriminated union with `tool-call`, `tool-result`, and `tool-error` variants:
>
> ```ts
> import { GuardDenied } from "owthorize"
>
> for (const step of result.steps) {
>   for (const part of step.content) {
>     if (part.type === "tool-error" && part.error instanceof GuardDenied) {
>       myLogger.warn({
>         tool: part.toolName,
>         matched: part.error.matched,
>         reason: part.error.reason,
>         irreversible: part.error.irreversible,
>       })
>     }
>   }
> }
> ```
>
> A logger that only inspects `step.toolResults` will silently miss every deny. The model still receives the error and self-corrects in plain English — but your alerting won't fire.

---

## 7. Test rules without side effects

`guard.simulate(toolName, payload)` runs the same evaluation pipeline but never invokes the handler. Use this in your test suite.

```ts
import { describe, it, expect } from "vitest"

describe("agent guardrails", () => {
  it("blocks DROP TABLE", () => {
    const decision = guard.simulate("db.query", { query: "DROP TABLE users" })
    expect(decision.decision).toBe("deny")
    expect(decision.matched).toBe("sql.denyDDL")
  })

  it("allows a parameterized SELECT", () => {
    const decision = guard.simulate("db.query", {
      query: "SELECT id FROM users WHERE id = $1",
      params: [42],
    })
    expect(decision.decision).toBe("allow")
  })
})
```

The audit log is still written for `simulate()` calls (with `simulated: true`), so you can also assert on what was logged.

---

## 8. Custom rules

Two flavors. Reach for the typed one when the rule is adapter-specific (almost always).

### `rules.<adapter>.custom` — typed (recommended)

`parsed` is narrowed to that adapter's shape in **both** `when` and `decide`. The runtime also auto-skips the rule when the call is on a tool whose adapter doesn't match — so you can attach a `rules.sql.custom` rule globally and it won't fire on HTTP tools.

```ts
import { rules, deny } from "owthorize"

const noPaymentsAfterHours = rules.sql.custom({
  name: "policy.payments_window",
  on: "db.query",
  when: ({ parsed }) =>
    parsed.kind === "insert" &&
    parsed.tables.includes("payments") &&
    new Date().getHours() >= 17,
  decide: () => deny("payments are read-only after 5 PM", "policy.payments_window"),
})
```

No `parsed.type !== "sql"` guard needed. `parsed.kind`, `parsed.tables`, `parsed.hasWhere`, etc. are all available without casts.

The same pattern exists at `rules.http.custom`, `rules.shell.custom`, `rules.fs.custom`.

### `rules.custom` — untyped (cross-adapter)

Use this only when the rule must inspect more than one adapter's parsed shape (rare). `parsed` is the full `ParsedAction` union; you re-narrow inside `decide`.

```ts
const auditTrailRule = rules.custom({
  on: ["db.query", "http.fetch"],
  when: ({ parsed }) =>
    (parsed.type === "sql" && parsed.kind === "delete") ||
    (parsed.type === "http" && parsed.method === "DELETE"),
  decide: () => deny("destructive op needs approval", "policy.requires_approval"),
})
```

### Tagging a custom deny as `irreversible`

`deny()` accepts an optional third arg with `{ irreversible: true }`. Use it when the action your rule blocks would be hard to undo if it ran — bulk inserts, destructive admin commands, expensive paid-API calls, anything you'd want a UI to double-confirm.

```ts
const noBulkProductInsert = rules.sql.custom({
  name: "policy.noBulkProductInsert",
  on: "db.query",
  when: ({ parsed }) =>
    parsed.kind === "insert" &&
    parsed.tables.includes("Product") &&
    (parsed.raw.match(/\(\s*\?/g) ?? []).length >= 100,
  decide: () =>
    deny(
      "bulk Product inserts (>= 100 rows) require manual approval",
      "policy.noBulkProductInsert",
      { irreversible: true },              // ← consumers route on this flag
    ),
})
```

The flag flows through to `GuardDenied.irreversible`, the audit record's `irreversible` field, and the routing pattern shown in §10. Omit the third arg to default to `false`.

### Both flavors — common ground

- `on` filters which tool the rule evaluates against (string or string[]).
- `when` and `decide` must be **synchronous**. Async returns throw at evaluation time.
- All custom rules are tagged `kind: "custom-local"` in the audit log so a future hosted mode can refuse to evaluate them.

---

## 9. Configure the audit log

By default, every check writes a structured JSON record to `console.log`. In a real app, point it at your logger:

```ts
const guard = new Guard({
  rules: [/* ... */],
  audit: {
    sink: (record) => myLogger.info({ owthorize: record }),
    fallbackSink: (record) => myLogger.warn({ owthorize_fallback: record }),
  },
  defaults: {
    onLogError: "continue", // never let logging break tool execution
  },
})
```

For tests and dev where you want zero output, import `silentSink`:

```ts
import { Guard, silentSink } from "owthorize"
const guard = new Guard({ audit: { sink: silentSink }, rules: [/* ... */] })
```

The default sink stays `console.log` deliberately — visible-by-default makes it harder to ship a service without an audit trail by accident. `silentSink` is opt-in.

Sensitive fields are stripped before the payload is hashed:

```ts
guard.tool("db.query", {
  adapter: "sql.postgres",
  handler: myHandler,
  redact: ["params.password", "params.creditCard.*"],
})
```

The audit record fields:

```ts
type AuditRecord = {
  ts: string                          // ISO 8601
  tool: string
  adapter: string | null
  parsed: ParsedAction | null         // typed parsed shape, or null on error
  payload_hash: string                // format: "sha256:<64-char hex>"
  decision: "allow" | "deny"
  matched_rule: string | null         // see §4 for built-in values, §10 for synthetic ones
  matched_rule_kind: "builtin" | "custom-local" | null
  reason: string | null
  irreversible: boolean               // true if the deny was tagged irreversible — see §4
  simulated: boolean
  agent_id?: string
  trace_id?: string
}
```

If you verify hashes externally, the `sha256:` prefix is part of the value (not just metadata). Strip it before passing to a comparator.

---

## 10. Failure modes (and what to set them to)

| Situation | `matched_rule` value in audit | Default | Override via |
|---|---|---|---|
| Call to a tool you didn't `guard.tool()` | `owthorize.unknownTool` | deny | `defaults.onUnknownTool: "allow"` |
| A rule throws an exception | `owthorize.ruleError:<rule-name>` | deny | `defaults.onRuleError: "allow"` |
| Adapter can't parse the payload | `owthorize.adapterError` | deny | `defaults.onAdapterError: "allow"` |
| Audit sink throws | (no audit emitted) | continue + write to fallback | `defaults.onLogError: "throw"` |

These are **synthetic rule names** the engine emits when a failure-mode policy denies. They appear in audit records exactly like rule denies, so test assertions against them are stable. They are not configurable themselves — only the deny-vs-allow behavior is.

Useful while you're prototyping:

```ts
const guard = new Guard({
  rules: [/* ... */],
  defaults: {
    onUnknownTool: "allow", // avoid being blocked by unwrapped tools you forgot
    onAdapterError: "deny", // keep this strict; mismatch means broken policy
  },
})
```

### Routing on the `irreversible` flag

A common pattern: auto-deny most things, but route irreversible denies through a human-approval flow before responding.

```ts
const decision = guard.simulate("db.query", payload)

if (decision.decision === "allow") {
  return safeQuery(payload) // run it
}

if (decision.irreversible) {
  // Your own approval system — Slack, ticket queue, whatever.
  // The SDK is already done; this is application code.
  await mySlackBot.requestApproval({ tool: "db.query", payload, decision })
  return res.status(202).json({ matched: decision.matched, status: "pending_approval" })
}

return res.status(403).json({ matched: decision.matched, reason: decision.reason })
```

The SDK never blocks waiting for approval — it returns the decision synchronously and lets your code decide whether to gate, route, or deny.

Once you've wrapped everything you intend to gate, set `onUnknownTool` back to `deny` (the default).

---

## 11. Common gotchas

- **Audit log floods stdout.** First thing most users want to fix. Pass a custom `sink`, or `silentSink` for zero output.
- **`onUnknownTool: deny` is the default.** If you call something you forgot to wrap, you get `GuardDenied` with `matched: "owthorize.unknownTool"`. Either wrap everything or relax the default while you build.
- **Adapter expects specific keys.** `sql.*` wants `{ query }`, `http` wants `{ url }`, `fs` wants `{ path }`, `shell` wants `{ command }` or `{ argv }`. Mismatches surface as `matched: "owthorize.adapterError"` and (by default) deny.
- **`fs.confineTo` does not follow symlinks.** A symlinked file inside the root that points outside it won't be blocked. Call `fs.realpath` in your handler if you need that defense.
- **`http.denyHosts` only blocks IP literals.** It does not resolve DNS. For DNS-rebinding protection, run behind an egress proxy.
- **`GuardDenied` extends `Error`.** Your existing `try/catch` (and your agent framework's tool-error handling) will receive it like any other error. The `irreversible` field is on the error too — `catch (e) { if (e instanceof GuardDenied && e.irreversible) ... }`.

---

## 12. TypeScript

All public types are exported from `owthorize`:

```ts
import type {
  Decision,           // { decision: "allow" } | { decision: "deny", reason, matched, irreversible? }
  DenyOptions,        // { irreversible?: boolean } — passed to deny()
  GuardOptions,
  GuardDefaults,
  ToolOptions,
  Rule,
  RuleContext,
  ParsedAction,       // discriminated union of SqlParsed | HttpParsed | ShellParsed | FsParsed | RawParsed
  SqlParsed,
  SqlParams,          // Array<string | number | boolean | null | Date | Buffer> — mutable, mysql2/pg-friendly
  HttpParsed,
  ShellParsed,
  FsParsed,
  AuditRecord,
  AuditSink,
} from "owthorize"

import { deny, GuardDenied, silentSink } from "owthorize"
```

The shim modules also export their tool-shape interfaces (`OpenAITool`, `AnthropicTool`, `LangChainTool`, `VercelTool`).

---

## 13. Reporting issues

When something behaves differently than this guide describes:

- API feels wrong → tell us the call site and what you expected.
- A rule false-positives or false-negatives → tell us the payload that surprised you.
- TypeScript type is too loose / too strict → paste the line.
- Adapter doesn't accept your payload shape → tell us the shape; we may add an adapter option or write a thin translator.
