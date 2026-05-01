# owthorize

[![npm version](https://img.shields.io/npm/v/owthorize.svg?color=blue)](https://www.npmjs.com/package/owthorize)
[![license](https://img.shields.io/npm/l/owthorize.svg?color=blue)](./LICENSE)
[![types](https://img.shields.io/npm/types/owthorize.svg)](./dist/index.d.ts)
[![node](https://img.shields.io/node/v/owthorize.svg)](./package.json)

> **Prompt safeguards are theater.** The model isn't the boundary — the layer between it and your systems is.

`owthorize` is a synchronous JS/TS library that sits between your AI agent and your systems (database, HTTP, filesystem, shell) and **blocks destructive tool calls before they execute**.

It understands what the call actually means — by parsing SQL into an AST, normalizing URLs, tokenizing shell commands — instead of pattern-matching strings. That distinction matters: regex misses `WHERE 1=1`, schema-qualified table names, and IPv4-mapped IPv6 addresses. owthorize doesn't.

```
Your agent calls a tool
        │
        ▼
  owthorize parses the payload into a typed shape
        │
        ▼
  Rules evaluate the parsed shape
        │
   ┌────┴────┐
 allow      deny
   │          │
handler    GuardDenied (your existing error handling catches it)
  runs
```

---

## Why this exists

AI agents call tools. Tools have side effects. Three things go wrong in production:

**1. Prompt injection.** Something the agent reads (a GitHub issue, a document, a web page) contains hidden instructions that coerce the model into making calls the developer never anticipated.

**2. Hallucinated arguments.** The model forms a syntactically valid tool call with the wrong payload — `DELETE FROM users` instead of `DELETE FROM users WHERE id = ?`.

**3. Reasoning errors.** The model tries to "be helpful" — runs destructive cleanup it wasn't asked to run, fetches an internal IP it shouldn't reach, writes outside its workspace.

In all three cases, a prompt-level safeguard ("you are a helpful assistant, do not drop tables") does nothing. The failure happens at the tool call, not at the prompt. That's where owthorize lives.

---

## Install

```bash
npm install owthorize
```

Node >= 18. Both ESM and CJS supported.

---

## Quickstart

```ts
import { Guard, rules, GuardDenied } from "owthorize"

const guard = new Guard({
  rules: [
    rules.sql.denyDDL(),                              // block DROP, ALTER, TRUNCATE, etc.
    rules.sql.denyMutationWithoutWhere(),              // block DELETE/UPDATE with no WHERE
    rules.http.denyHosts(rules.http.SSRF_DEFAULTS),   // block internal IPs, AWS metadata
  ],
})

// Wrap your tool handler once. owthorize intercepts every call.
const safeQuery = guard.tool("db.query", {
  adapter: "sql.postgres",
  handler: async ({ query }: { query: string }) => db.query(query),
})

// This gets blocked before it ever reaches your database:
try {
  await safeQuery({ query: "DROP TABLE users" })
} catch (err) {
  if (err instanceof GuardDenied) {
    console.log(err.matched, "->", err.reason)
    // sql.denyDDL -> DDL not allowed: drop
  }
}

// This runs normally:
await safeQuery({ query: "SELECT id FROM users WHERE id = $1" })
```

### Test your rules without hitting anything real

```ts
const result = guard.simulate("db.query", { query: "DROP TABLE users" })
// { decision: "deny", matched: "sql.denyDDL", reason: "DDL not allowed: drop", irreversible: true }
```

`guard.simulate()` runs the full evaluation pipeline but never calls your handler. Use it in your test suite to assert on rule behavior without side effects.

---

## What it catches

| Category | Examples blocked |
|---|---|
| SQL DDL | `DROP TABLE`, `TRUNCATE`, `ALTER TABLE`, `CREATE`, `RENAME` |
| Unbounded mutations | `DELETE FROM users` with no `WHERE`, `UPDATE users SET ...` with no `WHERE` |
| SSRF targets | `169.254.169.254` (AWS metadata), `192.168.x.x`, `localhost`, `*.internal`, IPv4-mapped IPv6 |
| Dangerous shell | `rm -rf`, pipe abuse, backtick / `$()` substitution, shell metacharacters |
| Path traversal | Anything that resolves outside your configured root directories |
| Custom policy | Whatever your project needs — typed rule functions, not Rego or regex strings |

---

## How it works: adapters

When your agent calls a tool, owthorize passes the payload through an **adapter** before rules evaluate it. The adapter turns the raw input into a typed, structured shape. Rules see that shape — not the original string.

| Adapter | What your tool receives | What rules see |
|---|---|---|
| `sql.postgres` / `sql.mysql` / `sql.sqlite` | `{ query, params? }` | `kind`, `tables`, `hasWhere`, `ddlOp`, `dialect` |
| `http` | `{ url, method?, headers?, body? }` | parsed URL with IPv4-mapped IPv6 normalization, lowercased header keys |
| `shell` | `{ command }` or `{ argv }` | tokenized argv, metacharacter / pipe / redirect / substitution flags |
| `fs` | `{ path, op? }` | normalized absolute path, op type |
| `raw` | anything | passthrough — use with cross-adapter custom rules |

This is the core difference from regex. A rule like `denyMutationWithoutWhere()` doesn't search for the word "WHERE" in a string — it checks whether the parsed SQL AST has a WHERE node. `DELETE FROM users WHERE 1=1` has a WHERE node; it passes this rule. That's expected behavior and is documented in USAGE.md.

---

## Built-in rules

```ts
// SQL
rules.sql.denyDDL()                         // DROP, TRUNCATE, ALTER, CREATE, RENAME
rules.sql.denyMutationWithoutWhere()         // UPDATE/DELETE with no WHERE clause
rules.sql.denyTables({ deny: ["users"] })    // block writes to specific tables
rules.sql.denyTables({ allow: ["logs"] })    // only allow writes to specific tables

// HTTP
rules.http.denyHosts(rules.http.SSRF_DEFAULTS)   // RFC1918, loopback, AWS metadata, *.internal
rules.http.denyHosts(["evil.com", "10.0.0.0/8"]) // custom host/CIDR denylist
rules.http.allowHosts(["api.stripe.com"])          // allowlist — everything else is denied

// Shell
rules.shell.denyCommands(["rm", "curl", "wget", "nc"])

// Filesystem
rules.fs.confineTo(["/tmp/agent-workspace"])  // deny anything outside this root

// Custom — typed per adapter, so your rule gets autocomplete on the parsed shape
rules.sql.custom({
  name: "no-payments-after-hours",
  when: ({ parsed }) => parsed.tables.includes("payments") && new Date().getHours() >= 17,
  decide: () => deny("payments table is read-only after 5pm", "policy.payments-window"),
})
```

All built-in rules that block irreversible actions (`denyDDL`, `denyMutationWithoutWhere`, destructive shell commands, fs writes outside roots) set `irreversible: true` on the deny result. Custom rules can opt into this too.

---

## The `irreversible` flag

Not all denies are equal. Blocking a `SELECT` on a forbidden table is different from blocking a `DROP TABLE`. The `irreversible` flag lets you route them differently in your own code — silent deny for most things, human approval for the ones that can't be undone:

```ts
const result = guard.simulate("db.query", payload)

if (result.decision === "allow")    return safeQuery(payload)
if (result.irreversible)            return slackBot.requestApproval(result)
return res.status(403).json({ matched: result.matched })
```

owthorize never blocks waiting for approval. It returns a decision synchronously and lets your code decide what to do with it.

---

## Framework integrations

Wrap your entire tool registry in one call. owthorize preserves all framework-specific fields and only intercepts the handler.

**OpenAI**

```ts
import { protectTools } from "owthorize/openai"

const safeTools = protectTools(guard, openaiTools, {
  db_query: { adapter: "sql.postgres" },
  fetch_url: { adapter: "http" },
})
// Pass safeTools to client.chat.completions.create({ tools: safeTools, ... })
```

**Vercel AI SDK**

```ts
import { protectTools } from "owthorize/vercel-ai"

const safeTools = protectTools(guard, tools, {
  db_query: { adapter: "sql.postgres" },
})
await generateText({ model, tools: safeTools, prompt })
```

**Anthropic SDK**

```ts
import { protectTools } from "owthorize/anthropic"
const safeTools = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
```

**LangChain JS**

```ts
import { protectTools } from "owthorize/langchain"
const safeTools = protectTools(guard, tools, { db_query: { adapter: "sql.postgres" } })
```

Tools without a handler (schema-only / client-side tools) pass through untouched.

---

## Audit log

Every evaluation — allow or deny, real or simulated — writes a structured record. By default it goes to `console.log`. Point it at your own logger in production:

```ts
const guard = new Guard({
  rules: [...],
  audit: {
    sink: (record) => logger.info({ owthorize: record }),
  },
})
```

Every record looks like this:

```json
{
  "ts": "2026-05-01T12:00:00Z",
  "tool": "db.query",
  "adapter": "sql.postgres",
  "parsed": { "kind": "ddl", "ddlOp": "drop", "tables": ["users"], "hasWhere": false },
  "payload_hash": "sha256:898f...",
  "decision": "deny",
  "matched_rule": "sql.denyDDL",
  "matched_rule_kind": "builtin",
  "reason": "DDL not allowed: drop",
  "irreversible": true,
  "simulated": false
}
```

Sensitive fields are stripped before hashing:

```ts
guard.tool("db.query", {
  adapter: "sql.postgres",
  handler: myHandler,
  redact: ["params.password", "params.apiKey"],
})
```

For tests where you want zero output:

```ts
import { Guard, silentSink } from "owthorize"
const guard = new Guard({ audit: { sink: silentSink }, rules: [...] })
```

---

## Failure modes and defaults

What happens when something goes wrong in the evaluation pipeline itself:

| Situation | Default | Override |
|---|---|---|
| Tool was never wrapped with `guard.tool()` | deny | `defaults.onUnknownTool: "allow"` |
| A rule throws an exception | deny | `defaults.onRuleError: "allow"` |
| Adapter can't parse the payload | deny | `defaults.onAdapterError: "allow"` |
| Audit sink throws | continue (writes to fallback sink) | `defaults.onLogError: "throw"` |

The default is always to fail closed. You can relax individual defaults while prototyping:

```ts
const guard = new Guard({
  rules: [...],
  defaults: {
    onUnknownTool: "allow",  // useful while you're still wrapping everything
  },
})
```

Set `onUnknownTool` back to `"deny"` (the default) once you've wrapped every tool you intend to gate.

---

## Threat model

**owthorize catches:** prompt-injected tool calls, hallucinated arguments, agent reasoning errors, and known unsafe payload shapes (DDL, unbounded mutations, SSRF targets, shell metacharacters, path traversal).

**owthorize does not catch:** a malicious agent runtime that bypasses the SDK entirely, vulnerabilities inside your own tool handler code, or side effects that happen before the tool boundary. The trust boundary is the wrap — what you don't wrap, you don't gate.

For defense against a hostile runtime you need a process boundary: a proxy, sidecar, or container egress rules. That's a separate layer and a different product.

---

## Design principles

**Parse, don't match.** Rules evaluate ASTs and parsed structures, not strings. Regex on SQL is a defect generator — it produces false negatives on valid SQL that looks slightly different than the pattern author expected.

**Synchronous.** Allow or deny, return immediately. No webhooks, no async approval state machine built into the SDK. The `irreversible` flag lets you route to your own approval flow without the SDK needing to know about it.

**Default deny on uncertainty.** Unknown tool, parser failure, rule exception — all deny by default. Failing open is a security anti-pattern.

**Wrap once.** `guard.tool(name, handler)` is the full API surface. You don't branch on `decision === "allow"` inside your handlers.

**Testable from day one.** `guard.simulate()` is a first-class API, not an afterthought. Every built-in rule ships with tests.

---

## Common gotchas

**The audit log floods stdout on startup.** This is intentional — visible-by-default means you can't accidentally ship a service with no audit trail. Pass a custom `sink` or `silentSink` to suppress it.

**`onUnknownTool: "deny"` is the default.** If you call a tool you forgot to wrap, you get `GuardDenied: unknown tool`. Relax this with `defaults.onUnknownTool: "allow"` while you're building, then set it back.

**The adapter expects specific payload keys.** `sql.*` expects `{ query }`. `http` expects `{ url }`. `fs` expects `{ path }`. `shell` expects `{ command }` or `{ argv }`. If your handler uses different key names, write a thin wrapper that renames them, or set `adapter: "raw"` and use a custom rule.

**`hasWhere` is structural, not semantic.** `DELETE FROM users WHERE 1=1` has a WHERE clause at the AST level, so `denyMutationWithoutWhere()` passes it. For stronger protection on specific tables, combine it with `denyTables`.

**`fs.confineTo` does not follow symlinks.** A symlink inside the allowed root that points outside it won't be caught. Call `fs.realpath` in your handler if you need that defense.

**`http.denyHosts` blocks IP literals, not DNS names.** It does not resolve hostnames. For DNS-rebinding protection, run behind an egress proxy.

---

## Status

v0.4.1 — the public API is stable but the version stays below 1.0 until field feedback from outside the original author lands.

**Validated end-to-end:** SQL adapter and rules, audit log, `guard.simulate()`, OpenAI shim, Vercel AI shim — all tested against a real Express + Drizzle + MySQL backend.

**Built and unit-tested, not yet field-validated:** HTTP adapter, SSRF rules, Anthropic shim, LangChain shim, shell adapter, FS adapter.

**On the path to v1.0:**
- API stabilization based on external user feedback
- LangChain and Anthropic shim end-to-end field runs
- Approval-flow recipes (Slack, queues) as documented patterns

**Not on the roadmap for v1** — these would break the synchronous model:
- Built-in human-approval UI or state machine
- Hosted policy server or multi-tenant control plane
- Row-count or blast-radius estimation that requires running the query

---

## Documentation

- [USAGE.md](./USAGE.md) — full guide: custom rules, framework wiring, audit log config, failure modes
- [FIELD-TESTING.md](./FIELD-TESTING.md) — validation status of every public surface
- [field-report.md](./field-report.md) — running log of what's been tested against real traffic

---

## Contributing

Bug reports with a minimal reproduction are the most valuable thing you can send. If you have the audit log line from the failing call, include it — it tells exactly where in the pipeline the evaluation went wrong.

```bash
git clone https://github.com/Spyyy004/owthorize.git
cd owthorize
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

The example scripts (`npm run example`, `npm run example:openai`, `npm run example:vercel-ai`) need an `OPENAI_API_KEY` for the framework-shim ones. The plain quickstart runs without any API key.

---

## License

MIT
