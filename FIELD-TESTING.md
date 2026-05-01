# Field testing checklist

This is the running record of what surfaces of `owthorize` have been validated against real traffic and what's still on the dogfood list. The main `USAGE.md` reads as user-facing reference; this file reads as engineering work-in-progress.

## Validated (in `field-report.md`)

| Surface | Cycle | Notes |
| --- | --- | --- |
| Engine: `Guard.tool`, `simulate`, `check`, audit pipeline | v0.2.0, re-verified v0.3.0 | Express + mysql2 backend, ~30 live calls |
| SQL adapter (`sql.mysql`, `sql.postgres`) + `denyDDL`, `denyMutationWithoutWhere`, `denyTables` | v0.2.0, re-verified v0.3.0 | `parsed.tables`, `parsed.kind`, `hasWhere` confirmed correct on real queries |
| HTTP adapter + `denyHosts(SSRF_DEFAULTS)` | v0.3.0 | All 7 deny cases including IPv4-mapped IPv6 (`[::ffff:127.0.0.1]` matched against `127.0.0.0/8`); 2 allow cases; `Authorization` header redacted |
| FS adapter + `confineTo` | v0.3.0 | Parent-traversal resolved before comparison; symlink limitation as documented |
| Shell adapter + `denyCommands` + metachar | v0.3.0 | Basename match (`/usr/bin/rm`), pipe / redirect / backtick / `$()` all caught |
| `rules.<adapter>.custom` typed flavors | v0.3.0 | `policy.noSelectStar` written without inner `parsed.type` re-guard |
| `redact` field-level config | v0.3.0 | Same query with rotated tokens produced identical `payload_hash` |
| `silentSink` | v0.3.0 | Zero stdout output, decision return values unaffected |
| Failure-mode synthetic rule names (`owthorize.unknownTool`, `owthorize.adapterError`) | v0.3.0 | Both fire correctly with the documented `matched_rule` value |

## Still to validate (v0.4 dogfood)

| Surface | Status | Recommended approach |
| --- | --- | --- |
| OpenAI shim end-to-end against real model | ❌ pending | `examples/openai-conversation.ts` runs a real `chat.completions.create` with tools wrapped through `protectTools` |
| Vercel AI shim end-to-end against real model | ❌ pending | `examples/vercel-ai-conversation.ts` runs a real `generateText` with tools wrapped through `protectTools` |
| `irreversible` flag round-trips through framework error paths | ❌ pending | Verify `GuardDenied.irreversible` is observable from a tool-error catch in OpenAI / Vercel handlers |

## Deferred (not on the v0.4/v1.0 path)

| Surface | Reason |
| --- | --- |
| Anthropic shim end-to-end | Lower priority than OpenAI / Vercel; defer to whoever needs it first |
| LangChain shim end-to-end | Same |
| Shell adapter validated against real `child_process` use | Most agents don't shell out; unit tests cover the destructive cases |
| FS adapter validated against real `fs/promises` use | Most agent file I/O goes through higher-level tools (vector stores, MCP) |

## How to run a validation pass

1. Wire one tool with a real handler (network/db/disk side effect).
2. Add the matching adapter + at least one rule to the `Guard`.
3. Run a deny case through `guard.simulate()` first (no side effect).
4. Run the same case live and confirm `GuardDenied` surfaces as expected.
5. Run an allow case live; confirm the handler runs and the audit log emits.
6. Inspect the audit log for surprises (missing fields, wrong `matched_rule`, payload shape).
7. File what surprised you in `field-report.md`.

## What to report

- Symptom + minimal reproduction (the `curl` / function call that triggered it).
- Whether `guard.simulate()` predicted the same outcome as the live call.
- TS friction (casts you had to add, types you wished existed).
- Doc gaps (anything in `USAGE.md` that misled you).
- Surprising audit-log content (or surprising silence).
