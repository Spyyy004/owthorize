# Changelog

All notable changes to `owthorize` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.4.2] — 2026-05-01

### Fixed

- Corrected `repository`, `homepage`, and `bugs` URLs in `package.json` to point at `github.com/Spyyy004/owthorize` (was pointing at a non-existent username in v0.4.1). README and changelog clone-URL references updated to match.

No code changes — strictly a metadata fix so npmjs.com links resolve correctly.

## [0.4.1] — 2026-05-01

Initial public release.

### Features

- **Synchronous policy gate** for AI-agent tool calls. `guard.tool(name, handler)` wraps a tool once; every invocation passes through a rule engine before any side effect happens.
- **Four adapters** with AST/structural parsing:
  - `sql.postgres` / `sql.mysql` / `sql.sqlite` — SQL AST via `node-sql-parser` (kind, target tables, `WHERE`/`LIMIT` presence, DDL operation).
  - `http` — parsed URL with IPv4-mapped IPv6 normalization and lowercased header keys.
  - `shell` — tokenized argv via `shell-quote` with metacharacter / pipe / redirect / substitution flags.
  - `fs` — normalized absolute path with op classification (read / write / delete / list).
- **Built-in rules**: `sql.denyDDL`, `sql.denyMutationWithoutWhere`, `sql.denyTables({ deny, allow })`, `http.denyHosts`/`allowHosts` + `SSRF_DEFAULTS`, `shell.denyCommands` (with built-in `DESTRUCTIVE_DEFAULTS`), `fs.confineTo`.
- **Custom rules** via `rules.custom({ on, when, decide })` (untyped) and per-adapter `rules.<adapter>.custom` (typed) — the typed versions narrow `parsed` in both `when` and `decide` and auto-skip when the call is on a non-matching adapter.
- **Framework integrations**: `protectTools(guard, tools, perTool?)` for `owthorize/openai`, `owthorize/anthropic`, `owthorize/langchain`, `owthorize/vercel-ai`. Wraps an entire tool registry in one call; preserves framework-specific fields (`strict`, `experimental_*`); passes schema-only tools (no handler / no `execute`) through untouched.
- **Structured audit log** — every check writes `{ ts, tool, adapter, parsed, payload_hash, decision, matched_rule, matched_rule_kind, reason, irreversible, simulated }`. Pluggable sink, `silentSink` for tests, redact-then-hash for sensitive fields (hash stable across rotated secrets).
- **`irreversible` flag** on the deny shape — built-in rules tag DDL, unbounded mutations, destructive shell commands (per `DESTRUCTIVE_DEFAULTS`), and writes/deletes outside fs roots. Custom rules opt in via `deny(reason, matched, { irreversible: true })`. Consumers route on it to surface destructive denies to a human-approval flow without coupling the SDK to one.
- **`guard.simulate(tool, payload)`** — same evaluation pipeline as the live call, no handler invoked, audit record still emitted with `simulated: true`.
- **Failure modes**: `onUnknownTool`, `onRuleError`, `onAdapterError`, `onLogError` — each individually configurable, all default-deny on uncertainty. Synthetic rule names (`owthorize.unknownTool`, `owthorize.ruleError:<name>`, `owthorize.adapterError`) appear in audit records for assertion.

### Validated

- 271 tests across 18 files. Typecheck clean, biome lint clean, dual ESM/CJS build with `.d.ts`/`.d.cts` per entry.
- End-to-end dogfood against a real Express + Drizzle + MySQL backend (raw `mysql2`, `axios`, `fs/promises`, `child_process` handlers), four cycles documented in [`field-report.md`](./field-report.md).
- OpenAI and Vercel AI shims field-tested against `gpt-4o-mini`: model self-corrects on deny, `irreversible` flag surfaces in the model's natural-language explanation.

### Notes

- Node ≥ 18.
- Synchronous v1 design — no webhooks, no async approval state machine. Approvals belong in consumer code, gated on the `irreversible` flag.

[Unreleased]: https://github.com/Spyyy004/owthorize/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/Spyyy004/owthorize/releases/tag/v0.4.2
[0.4.1]: https://github.com/Spyyy004/owthorize/releases/tag/v0.4.1
