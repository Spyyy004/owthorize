# owthorize

[![npm version](https://img.shields.io/npm/v/owthorize.svg?color=blue)](https://www.npmjs.com/package/owthorize)
[![license](https://img.shields.io/npm/l/owthorize.svg?color=blue)](./LICENSE)
[![types](https://img.shields.io/npm/types/owthorize.svg)](./dist/index.d.ts)
[![node](https://img.shields.io/node/v/owthorize.svg)](./package.json)

> **Prompt safeguards are theater.** The model isn't the boundary — the layer between it and your systems is.

`owthorize` is a synchronous JS/TS gate that catches destructive AI-agent tool calls **before they execute**, using ASTs and parsed shapes — not regex on strings. It sits at the tool layer of your agent (OpenAI, Anthropic, LangChain, Vercel AI SDK) and gates every call through a small rule engine.

```ts
// the model emits this:
db.query("DROP TABLE users")
//              │
//              ▼  guard.tool() intercepts, parses, denies
//              │
throw new GuardDenied("DDL not allowed: drop")
```

---

## The problem

Modern AI agents call tools. Tools have side effects. Three things go wrong:

1. **Prompt injection.** A user (or a document the agent reads) coerces the model into emitting calls the developer never anticipated.
2. **Hallucinated arguments.** The model forms a syntactically-valid call with semantically-wrong inputs — `DELETE FROM users` instead of `DELETE FROM users WHERE id = ?`.
3. **Reasoning errors.** The model tries to "be helpful" by issuing destructive cleanup, fetches an internal IP it shouldn't reach, or writes outside the workspace.

Prompt-level safeguards ("you are a helpful assistant, do not drop tables") fail under all three. The right boundary is the layer between the model and your database/HTTP/disk — the tooling layer. That's where `owthorize` lives.

## What it catches

- **SQL DDL** — `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `RENAME` (Postgres / MySQL / SQLite, AST-level)
- **Unbounded mutations** — `UPDATE` / `DELETE` with no `WHERE` clause
- **SSRF targets** — RFC1918, link-local, loopback, AWS metadata `169.254.169.254`, IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`), `*.internal` wildcards
- **Shell metacharacters and dangerous commands** — basename match (`/usr/bin/rm` → `rm`), pipe / redirect / `$()` / backtick detection
- **Path traversal** — resolved-path containment, prefix-collision-safe (root `/safe` doesn't match `/safe-evil`)
- **Project-specific policy** — typed custom rules per adapter (`rules.sql.custom`, `rules.http.custom`, etc.)

## Who it's for

JS/TS developers shipping AI agents that touch:

- a database (Postgres, MySQL, SQLite — via `mysql2`, `pg`, `sqlite3`, etc.)
- outbound HTTP (`fetch`, `axios`, `undici`)
- the filesystem (`fs/promises`)
- shell exec (`child_process`)

If your agent is read-only against trusted data, you probably don't need this. If it can write — or if it can fetch arbitrary URLs — `owthorize` closes the most-likely failure modes before they ship.

---

## Install

```bash
npm install owthorize
```

Both ESM and CJS are supported. Node ≥ 18.

## Quickstart

```ts
import { Guard, rules, GuardDenied } from "owthorize"

const guard = new Guard({
  rules: [
    rules.sql.denyDDL(),
    rules.sql.denyMutationWithoutWhere(),
    rules.http.denyHosts(rules.http.SSRF_DEFAULTS),
  ],
})

const safeQuery = guard.tool("db.query", {
  adapter: "sql.postgres",
  handler: async ({ query }: { query: string }) => db.query(query),
})

try {
  await safeQuery({ query: "DROP TABLE users" })
} catch (err) {
  if (err instanceof GuardDenied) {
    console.log(err.matched, "→", err.reason)
    // → sql.denyDDL → DDL not allowed: drop
  }
}

await safeQuery({ query: "SELECT id FROM users WHERE id = $1" })
// runs the handler
```

Test rules without side effects:

```ts
guard.simulate("db.query", { query: "DROP TABLE users" })
// → { decision: "deny", reason: "DDL not allowed: drop", matched: "sql.denyDDL", irreversible: true }
```

For the full guide (custom rules, framework shims, audit log, failure modes, the `irreversible` flag): see [USAGE.md](./USAGE.md).

---

## What's in the box

### Adapters

Adapters parse the raw payload into a typed shape. Rules see ASTs, not strings.

| Adapter | Payload | Parses into |
|---|---|---|
| `sql.postgres` / `sql.mysql` / `sql.sqlite` | `{ query, params? }` | `kind`, `tables`, `hasWhere`, `ddlOp`, `dialect` |
| `http` | `{ url, method?, headers?, body? }` | parsed URL with IPv4-mapped IPv6 normalization, lowercased header keys |
| `shell` | `{ command }` or `{ argv }` | tokenized argv, metacharacter / pipe / redirect / substitution flags |
| `fs` | `{ path, op? }` | normalized absolute path, op classification |
| `raw` | anything | passthrough — for cross-adapter custom rules |

### Built-in rules

| Rule | Blocks | Tags `irreversible` |
|---|---|---|
| `rules.sql.denyDDL()` | `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `RENAME` | yes |
| `rules.sql.denyMutationWithoutWhere()` | `UPDATE` / `DELETE` with no `WHERE` | yes |
| `rules.sql.denyTables({ deny, allow })` | Configured table denylist or allowlist (case-insensitive, schema-stripped) | yes for writes, no for SELECT |
| `rules.http.denyHosts(list)` | Host literals, IPv4/IPv6 CIDRs, `*.wildcards` | no |
| `rules.http.allowHosts(list)` | Anything not on the list | no |
| `rules.http.SSRF_DEFAULTS` | RFC1918, link-local, loopback, AWS metadata, `*.internal`, `*.local` | (constant) |
| `rules.shell.denyCommands(list, opts?)` | Banned commands (basename) **plus** metacharacter abuse | yes for `rm`/`dd`/`mkfs`/etc., configurable via `destructive` option |
| `rules.fs.confineTo(roots, opts?)` | Anything outside the configured roots | yes for write/delete, no for read/list |
| `rules.<adapter>.custom({ on, when, decide })` | Project-specific predicates, typed `parsed` per adapter | opt-in via `deny(reason, matched, { irreversible: true })` |

### Framework integrations

`protectTools(guard, tools, perTool?)` wraps an entire tool registry in one call:

```ts
import { protectTools } from "owthorize/openai"

const safeTools = protectTools(guard, openaiTools, {
  db_query: { adapter: "sql.postgres", redact: ["params.password"] },
})
```

Available at:

- `owthorize/openai` — `Array<{ type: "function", function, handler? }>`
- `owthorize/anthropic` — `Array<{ name, description, input_schema, handler? }>`
- `owthorize/langchain` — `Array<{ name, description, schema, func | _call }>`
- `owthorize/vercel-ai` — `Record<string, { description, parameters, execute? }>`

All four shims preserve framework-specific fields (`strict`, `experimental_*`, etc.) and pass schema-only tools (no handler / no `execute`) through untouched.

### Audit log

Every check writes a structured record:

```json
{
  "ts": "2026-05-01T12:00:00Z",
  "tool": "db.query",
  "adapter": "sql.postgres",
  "parsed": { "kind": "ddl", "ddlOp": "drop", "tables": ["users"], "hasWhere": false },
  "payload_hash": "sha256:898f9f1f624ca10a59e92c9483c39a9991f5664d19135b4b442fd92e1c92cb1d",
  "decision": "deny",
  "matched_rule": "sql.denyDDL",
  "matched_rule_kind": "builtin",
  "reason": "DDL not allowed: drop",
  "irreversible": true,
  "simulated": false
}
```

- Pluggable sink (`audit: { sink: myLogger }`)
- `silentSink` exported for tests / dev
- Field-level redaction (`redact: ["params.password"]`) — sensitive values are stripped **before** hashing, so the hash is stable across rotated secrets
- Audit failures fall back to a secondary sink and never break tool execution

### The `irreversible` flag

Built-in rules tag denies that block actions you couldn't easily roll back (DDL, unbounded mutations, destructive shell, writes outside fs roots). Custom rules opt in via `deny(reason, matched, { irreversible: true })`. Consumers route on it — auto-deny most things, escalate the irreversible ones to a human:

```ts
const decision = guard.simulate("db.query", payload)

if (decision.decision === "allow") return safeQuery(payload)
if (decision.irreversible) return mySlackBot.requestApproval(decision)
return res.status(403).json({ matched: decision.matched })
```

The SDK never blocks waiting for approval — it returns synchronously and lets your code decide whether to gate, route, or deny.

---

## Threat model

**Catches:** prompt-injected tool calls, hallucinated arguments, agent reasoning errors, classes of unsafe shapes (DDL, unbounded mutations, SSRF, shell metacharacters, path traversal).

**Does not catch:** a malicious agent runtime that bypasses the SDK, vulnerabilities inside your tool implementations, side effects that occur before the tool boundary. The trust boundary is the wrap; what you don't wrap, you don't gate. For defense against a hostile runtime, you need a process boundary (proxy, sidecar, container egress rules) — that's a different product.

## Design principles

1. **Parse, don't match.** Rules see ASTs and parsed URLs, not strings. Regex on SQL is a defect generator.
2. **Synchronous v1.** Allow or deny, return immediately. No webhooks, no async resume. The `irreversible` flag lets consumers route to their own approval flow without coupling the SDK to one.
3. **Default deny on uncertainty.** Unknown tool, parser failure, rule exception — all deny by default. Each is configurable.
4. **Wrap once at the tool layer.** `guard.tool(name, handler)` is the API. Developers don't branch on `decision.status === "allow"` in their own code.
5. **Testable from day one.** Built-in rules ship with unit tests. `simulate()` is a first-class API.

## Status & roadmap

`owthorize` is at v0.4.1 — the public API is stable but the version stays sub-1.0 until field feedback from outside the original author lands. The validation log lives in [FIELD-TESTING.md](./FIELD-TESTING.md) and the running paper-cut report in [field-report.md](./field-report.md). Both have been re-tested end-to-end across all four adapters, framework shims (OpenAI + Vercel AI against `gpt-4o-mini`), and the `irreversible` flag on a real Express + Drizzle + MySQL backend.

**On the path to v1.0:**

- API stabilization based on real-world feedback from external users
- LangChain + Anthropic shim end-to-end runs (built and unit-tested; not yet field-validated)
- Approval-flow recipes (Slack / queue) as documented patterns, not SDK code

**Explicitly not on the roadmap** (these would deform the synchronous v1):

- Built-in human-approval UI / state machine
- Hosted policy server, multi-tenant control plane
- Anything async beyond the handler itself
- Row-count / blast-radius estimation that requires running the query

## Documentation

- [USAGE.md](./USAGE.md) — full user guide (custom rules, framework wiring, audit, failure modes)
- [MVP.md](./MVP.md) — original v1 spec
- [FIELD-TESTING.md](./FIELD-TESTING.md) — validation status of every public surface
- [field-report.md](./field-report.md) — running log of what's been dogfooded against real traffic

## Contributing

Issues and PRs welcome. Bug reports with a minimal reproduction (the call site that surprised you, plus the audit-log line if you have it) are gold.

```bash
git clone https://github.com/Spyyy004/owthorize.git
cd owthorize
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

The example scripts (`npm run example`, `npm run example:openai`, `npm run example:vercel-ai`) require an `OPENAI_API_KEY` for the framework-shim ones. The plain `quickstart` runs without any API key.

## License

MIT — see [LICENSE](./LICENSE).
