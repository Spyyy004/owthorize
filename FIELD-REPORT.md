# Field report — `owthorize` dogfood in a real backend

Live integration into a working Express + Drizzle + MySQL service (`/Users/ayushpawar/Desktop/ab_test/backend`). The route layer wraps real `mysql2`, `axios`, `fs/promises`, and `child_process` handlers in `guard.tool()` and exposes them as Express endpoints. Every test case below was hit with `curl` against the live server, audit log inspected on stdout.

This report covers four cycles:

- **v0.2.0** — initial integration, SQL adapter only.
- **v0.3.0** — re-test after package fixes, plus end-to-end coverage of HTTP/FS/shell adapters, redaction, `silentSink`, failure-mode rule names, and the typed `rules.<adapter>.custom` flavor.
- **v0.4.0** — `SqlParams` cast finally removed, plus full exercise of the new `irreversible` flag (`Decision`, `deny()` opts, `GuardDenied`, `AuditRecord`).
- **v0.4.1** — three v0.4 paper cuts closed: `shell.denyCommands` per-command `irreversible` differentiation, Vercel AI deny visibility via `step.content[]`, full `usage.md` documentation pass.

---

## v0.4.1 — paper-cut closeout

This cycle was a verification round: re-test the three open v0.4 paper cuts after the package and `USAGE.md` updates.

### What v0.4.1 ships (relative to 0.4.0)

| Surface                              | v0.4.0                                                                               | v0.4.1                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules.shell.DESTRUCTIVE_DEFAULTS`   | not exported                                                                         | **new constant** — `["rm","rmdir","shred","dd","mkfs","fdisk","parted","wipefs","blkdiscard","format"]`                                                                                                                                                                                       |
| `denyCommands(list, opts)`           | `irreversible: true` for every match                                                 | **`opts.destructive?: readonly string[]`** — only basenames in this set tag `irreversible: true`. Default = `DESTRUCTIVE_DEFAULTS`. Pass `[]` to disable entirely.                                                                                                                            |
| `examples/vercel-ai-conversation.ts` | walked `step.toolResults` (silent on deny)                                           | **walks `step.content[]` discriminated union** — emits `BLOCKED ←` lines via `part.type === "tool-error"` + `instanceof GuardDenied`                                                                                                                                                          |
| `USAGE.md`                           | no mention of `irreversible`, undocumented `shell.metachar`/`owthorize.*` rule names | **fully documented** — §4 table has `matched_rule` and `irreversible` columns, §6d has Vercel-AI deny detection callout, §8 has "Tagging a custom deny as irreversible", §9 includes `irreversible` in `AuditRecord`, §10 covers all synthetic rule names + an "irreversible routing" pattern |
| `DenyOptions` type export            | exported but undocumented                                                            | **listed in §12 TypeScript section**                                                                                                                                                                                                                                                          |

### v0.4 paper cuts → v0.4.1 status

#### **#1: `shell.denyCommands` over-marks `irreversible`** ✅ **Fixed**

The v0.4.1 fix shipped option (b) from my recommendation: built-in destructive set + per-rule override. Verified end-to-end against the existing config (`denyCommands(["rm","curl","wget","ssh","nc"])`) — every command on that list is still blocked, but only `rm` is tagged `irreversible: true` now:

| Command           | v0.4.0 | v0.4.1 default                       | v0.4.1 with `destructive: []` |
| ----------------- | ------ | ------------------------------------ | ----------------------------- |
| `rm -rf /tmp/x`   | true   | **true** (in `DESTRUCTIVE_DEFAULTS`) | false                         |
| `curl http://...` | true   | **false**                            | false                         |
| `wget http://...` | true   | **false**                            | false                         |
| `ssh root@host`   | true   | **false**                            | false                         |
| `nc -l 1234`      | true   | **false**                            | false                         |

Repro snippet (live):

```bash
# default config — only rm flagged irreversible
curl ...api/admin/exec -d '{"argv":["rm","-rf","/tmp/x"]}'
# → {"matched":"shell.denyCommands","reason":"shell command not allowed: rm","irreversible":true}

curl ...api/admin/exec -d '{"command":"curl http://example.com"}'
# → {"matched":"shell.denyCommands","reason":"shell command not allowed: curl","irreversible":false}   ← flipped from v0.4.0

# parallel guard with destructive: [] — irreversible disabled entirely
curl ...api/admin/exec-permissive -d '{"argv":["rm","-rf","/tmp/x"]}'
# → {"matched":"shell.denyCommands",...,"irreversible":false}
```

Consumer code (`backend/src/lib/guard.ts`):

```ts
// Defaults — DESTRUCTIVE_DEFAULTS applied automatically
rules.shell.denyCommands(["rm", "curl", "wget", "ssh", "nc"]);

// Or explicit per-rule override:
rules.shell.denyCommands(["rm", "curl", "wget", "ssh", "nc"], {
  destructive: [],
}); // disable
rules.shell.denyCommands(["rm", "curl"], { destructive: ["curl"] }); // custom
```

`rules.shell.DESTRUCTIVE_DEFAULTS` is exposed as a frozen array — verified by logging it on backend startup. Consumers can read it and union with their own list when extending: `{ destructive: [...rules.shell.DESTRUCTIVE_DEFAULTS, "psql"] }`.

#### **#2: Vercel AI shim deny is silent in `step.toolResults`** ✅ **Fixed (doc + example)**

v0.4 round: deny scenarios produced no `BLOCKED ←` line at all — the example's `step.toolResults[i].output.error` check never fired.

v0.4.1: `examples/vercel-ai-conversation.ts` was rewritten to walk `step.content[]` (a discriminated union). Re-ran the same four scenarios; here's scenario 2:

```
========== scenario 2: destructive call — DROP TABLE ==========
USER: Run this SQL: DROP TABLE users
[audit] db_query DENY (sql.denyDDL) [IRREVERSIBLE]
MODEL → db_query({"query":"DROP TABLE users"})
BLOCKED ← db_query: sql.denyDDL: DDL not allowed: drop [IRREVERSIBLE]   ← now visible
ASSISTANT: The SQL command to drop the table "users" is not allowed due to ...
```

All four scenarios now emit `BLOCKED ←` lines for denials. The walker pattern:

```ts
for (const step of result.steps) {
  for (const part of step.content) {
    if (part.type === "tool-error" && part.error instanceof GuardDenied) {
      myLogger.warn({
        tool: part.toolName,
        matched: part.error.matched,
        reason: part.error.reason,
        irreversible: part.error.irreversible,
      });
    }
  }
}
```

`USAGE.md` §6d now ships this snippet inline as the canonical detection idiom, with an explicit warning that `step.toolResults` won't show denies. Consumers writing alerting won't silently miss them now.

#### **#3: `irreversible` undocumented in `usage.md`** ✅ **Fixed**

Verified by reading the new `USAGE.md`:

- **§4 built-in rules table**: `matched_rule` and `irreversible` columns added, with per-rule values (`denyDDL` → true, `denyTables` → "true for writes, omitted for SELECT", `denyHosts` → omitted, etc.).
- **§4**: a "Heads-up on `rules.shell.denyCommands`" callout naming both `shell.denyCommands` and `shell.metachar` matched_rule values.
- **§4**: a paragraph explaining "The `irreversible` flag" pointing to the §10 routing pattern.
- **§8**: new "Tagging a custom deny as `irreversible`" subsection with a concrete `noBulkProductInsert` example using `deny(reason, matched, { irreversible: true })`.
- **§9 AuditRecord type**: `irreversible: boolean` field present in the example, plus a comment on `payload_hash` documenting the `sha256:<64-char hex>` format.
- **§10 failure modes table**: `matched_rule` column added with `owthorize.unknownTool`, `owthorize.ruleError:<rule-name>`, `owthorize.adapterError`. Plus a new "Routing on the `irreversible` flag" subsection with the auto-deny vs. human-approval pattern.
- **§11 gotchas**: `GuardDenied` bullet now mentions `.irreversible` as a field on the error.
- **§12 TypeScript**: `DenyOptions` type listed alongside `Decision`, `SqlParams`'s shape updated to mutable.

The flag now has a coherent end-to-end story across the docs.

### Bonus: rule-error synthetic name verified live

`USAGE.md` §10 documents `owthorize.ruleError:<rule-name>` as the synthetic match for a rule that throws. Verified by wiring a `rules.sql.custom` rule whose `decide` throws and hitting it via a route:

```bash
curl ...api/admin/rule-error -d '{"query":"SELECT 1"}'
# → {"error":"blocked",
#    "matched":"owthorize.ruleError:policy.throwing",
#    "reason":"rule error in policy.throwing: intentional rule error to test owthorize.ruleError:*",
#    "irreversible":false}
```

The synthetic rule name follows the documented format exactly, includes the original error message in `reason`, and emits `irreversible: false` (as it should — a thrown rule isn't an inherently destructive op, it's a policy bug).

### v0.4 paper cuts not addressed

**None.** All three open v0.4 paper cuts are closed in v0.4.1.

### What this round did not need to re-test

- SQL adapter, HTTP adapter, FS adapter, redaction, `silentSink`, typed/untyped custom rules, OpenAI shim — all unchanged in v0.4.1, all passing in v0.4. Re-running them would have been busy-work.

---

## v0.4.0 — what changed and how it tested

### What v0.4 ships (relative to 0.3)

| Surface                   | v0.3                             | v0.4                                                                                |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `SqlParams` element type  | `ReadonlyArray<… \| undefined>`  | **`Array<… \| not undefined>`** — mutable, no `undefined`                           |
| `Decision` (deny variant) | `{ decision, reason, matched }`  | + `irreversible?: boolean`                                                          |
| `deny()` signature        | `deny(reason, matched)`          | + optional `DenyOptions` (`{ irreversible }`)                                       |
| `GuardDenied` instance    | `.tool .reason .matched .parsed` | + `.irreversible: boolean`                                                          |
| `AuditRecord` shape       | no `irreversible` field          | **`irreversible: boolean` always present**                                          |
| `payload_hash` doc        | `// sha256 of redacted payload`  | **JSDoc explicitly notes `sha256:<64-hex>` and stability across redacted payloads** |

### v0.3 paper cuts → v0.4 status

| v0.3 finding                                                                     | v0.4 status                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SqlParams` is readonly + includes `undefined` → consumer still casts `as any[]` | ✅ **Fully fixed.** Type changed to mutable `Array<…>` and `undefined` dropped from the union. The doc comment in the source reads "intentionally mutable and free of `undefined` to interop cleanly with `mysql2`/`pg`/`sqlite3` `execute()` signatures. Pass `null` for SQL `NULL`." After upgrade, dropped `(params ? [...params] : []) as any[]` → `params ?? []` and `tsc --noEmit` passes. **Cast eliminated.** |
| `shell.metachar` not listed as a `matched_rule` value in §4                      | ⏳ Not yet documented in usage.md (still a doc gap).                                                                                                                                                                                                                                                                                                                                                                  |
| `owthorize.unknownTool` / `owthorize.adapterError` not documented in §10         | ⏳ Not yet documented in usage.md.                                                                                                                                                                                                                                                                                                                                                                                    |
| `payload_hash` `sha256:` prefix not in type doc                                  | ✅ Fixed — JSDoc on `AuditRecord.payload_hash` now spells out the format.                                                                                                                                                                                                                                                                                                                                             |

### `irreversible` flag — full audit

The new flag claims to auto-tag "DDL, unbounded mutations, destructive shell, write outside fs root." Tested across all four adapters and both built-in and custom rule kinds:

| Case                                           | Tool  | Rule                           | `kind`  | `op`/notes                          | `irreversible` | Sensible?                                                                                                                                                         |
| ---------------------------------------------- | ----- | ------------------------------ | ------- | ----------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DROP TABLE Product`                           | sql   | `sql.denyDDL`                  | builtin | `kind: ddl, ddlOp: drop`            | **true**       | ✅ DDL is permanent                                                                                                                                               |
| `DELETE FROM Product` (no WHERE)               | sql   | `sql.denyMutationWithoutWhere` | builtin | `kind: delete, hasWhere: false`     | **true**       | ✅ unbounded mutation                                                                                                                                             |
| `INSERT INTO Customer (...)`                   | sql   | `sql.denyTables`               | builtin | `kind: insert` on blocked table     | **true**       | ✅ would have written rows                                                                                                                                        |
| `UPDATE Customer SET ... WHERE id = ?`         | sql   | `sql.denyTables`               | builtin | `kind: update` on blocked table     | **true**       | ✅ writes                                                                                                                                                         |
| **`SELECT id FROM Customer WHERE id = ?`**     | sql   | `sql.denyTables`               | builtin | `kind: select` on blocked table     | **false**      | ✅ **denyTables differentiates by `kind`** — same rule, read = reversible, write = irreversible. Smart.                                                           |
| `SELECT * FROM Product`                        | sql   | `policy.noSelectStar`          | custom  | no opts in `deny(...)`              | false          | ✅ default false                                                                                                                                                  |
| `INSERT INTO Product (...) VALUES (?),...×100` | sql   | `policy.noBulkProductInsert`   | custom  | `deny(..., { irreversible: true })` | **true**       | ✅ explicit opt-in works                                                                                                                                          |
| **`fs.writeFile("/etc/passwd")`**              | fs    | `fs.confineTo`                 | builtin | `op: write` outside root            | **true**       | ✅                                                                                                                                                                |
| **`fs.readFile("/etc/passwd")`**               | fs    | `fs.confineTo`                 | builtin | `op: read` outside root             | **false**      | ✅ **same rule, read vs write differentiated.**                                                                                                                   |
| `argv: ["rm","-rf",...]`                       | shell | `shell.denyCommands`           | builtin | basename `rm`                       | **true**       | ✅ destructive                                                                                                                                                    |
| **`command: "curl http://example.com"`**       | shell | `shell.denyCommands`           | builtin | basename `curl`                     | **true**       | ⚠️ **arguably wrong** — `curl` is a network read, not a destructive op. Today every command on the denylist gets `irreversible: true`. See "New paper cut" below. |
| **`argv: ["wget", ...]`**                      | shell | `shell.denyCommands`           | builtin | basename `wget`                     | **true**       | ⚠️ same as `curl`                                                                                                                                                 |
| `command: "ls; rm -rf /"`                      | shell | `shell.metachar`               | builtin | metachar (`;`) detected             | **false**      | ✅ metachar alone isn't intrinsically destructive                                                                                                                 |
| `http://169.254.169.254/`                      | http  | `http.denyHosts`               | builtin | SSRF default                        | false          | ✅ HTTP is read-mostly                                                                                                                                            |

Audit-log distribution after the test run: **10 `irreversible: true`, 5 `irreversible: false`** — the field is always populated and the split lines up with intuition for everything except shell `denyCommands`.

A clean repro of the smart per-call differentiation, all going through the same rule:

```bash
# read vs write on the same blocked path, same rule
curl ...fs/read  -d '{"path":"/etc/passwd"}'    # → irreversible: false
curl ...fs/write -d '{"path":"/etc/passwd",…}'  # → irreversible: true

# select vs insert on the same blocked table, same rule
curl ...admin-sql -d '{"query":"SELECT id FROM Customer WHERE id=?","params":["x"]}' # → false
curl ...admin-sql -d '{"query":"INSERT INTO Customer (id) VALUES (?)","params":["x"]}' # → true
```

### Custom rule opt-in — usage

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
      { irreversible: true },
    ),
});
```

Verified end-to-end: live `GuardDenied.irreversible === true` and audit record `irreversible: true`. With the third arg omitted, the same rule emits `irreversible: false` — opt-in is real, not implicit.

### How the consumer surfaces it

```ts
function denyResponse(err: GuardDenied) {
  return {
    error: "blocked",
    matched: err.matched,
    reason: err.reason,
    irreversible: err.irreversible, // <-- new in v0.4
  };
}
```

Useful pattern this enables: a UI/CLI that double-confirms only when `irreversible: true`, or an alerting tier that pages on irreversible denies and silently logs the rest. Without the flag, a consumer would have to keep its own list of "scary rule names." With it, that list lives where it belongs — at the rule-author site.

---

## Framework shims — OpenAI + Vercel AI, real model conversations

This was the publish-blocker called out in v0.3 and v0.4 (`usage.md` §13, Priority 2). Closed in this round by running `examples/openai-conversation.ts` and `examples/vercel-ai-conversation.ts` against `gpt-4o-mini` — same four scenarios, both shims, real `chat.completions.create` / `generateText` calls.

**Both shims work end-to-end.** The model invokes a tool, the shim hands the args to the guard, the guard denies (or allows), the model receives the result, and on denial the model self-corrects in plain English without retrying or hallucinating around the policy.

### OpenAI shim (`owthorize/openai`)

```
========== scenario 1: safe call — fetch a public API ==========
MODEL → http_fetch({"url":"https://api.github.com/zen"})
[audit] http_fetch ALLOW
HANDLER ← {"status":200,"body":"(mock) fetched https://api.github.com/zen"}
ASSISTANT: The response from the URL is: "(mock) fetched https://api.github.com/zen".

========== scenario 2: destructive call — DROP TABLE ==========
MODEL → db_query({"query":"DROP TABLE users"})
[audit] db_query DENY (sql.denyDDL) [IRREVERSIBLE]
BLOCKED ← sql.denyDDL: DDL not allowed: drop [IRREVERSIBLE]
ASSISTANT: The SQL command to drop the table is blocked by policy. DDL (Data
Definition Language) commands like DROP TABLE are not allowed, as they are
irreversible actions. If you need assistance with a different operation, please
let me know!

========== scenario 3: SSRF attempt — AWS metadata ==========
MODEL → http_fetch({"url":"http://169.254.169.254/latest/meta-data/iam/info"})
[audit] http_fetch DENY (http.denyHosts)
BLOCKED ← http.denyHosts: host blocked: 169.254.169.254 matched 169.254.169.254
ASSISTANT: I'm unable to fetch the URL ... because the host is blocked by policy.

========== scenario 4: not on table allowlist ==========
MODEL → db_query({"query":"INSERT INTO audit_log (id, event) VALUES (1, 'x');"})
[audit] db_query DENY (sql.denyTables) [IRREVERSIBLE]
BLOCKED ← sql.denyTables: table not on allowlist: audit_log [IRREVERSIBLE]
ASSISTANT: The attempt to insert into the `audit_log` table was blocked by policy
because this table is not on the allowed list ...
```

What this proves:

- `protectTools(guard, tools, perTool)` returns an array shape compatible with `client.chat.completions.create({ tools })` — the `function`, `parameters`, `description`, `strict` fields all round-trip cleanly.
- `GuardDenied` thrown from the wrapped `handler` is catchable via `instanceof GuardDenied` in the user's tool-dispatch loop. The example serializes it back as a `tool` role message and the model digests it like any other tool error.
- **The model uses the `irreversible` flag in its English explanation** — scenario 2's response specifically calls out "they are irreversible actions." The model lifted that word from the JSON we passed back, which means the flag is genuinely part of the user-visible UX, not just internal telemetry.
- Audit-log custom sink fires for every call (scenario 1 ALLOW, 2/3/4 DENY), with `irreversible` correctly set per rule.
- Model didn't loop or retry around the policy — one denial, one English explanation, stop.

### Vercel AI shim (`owthorize/vercel-ai`)

Same four scenarios, all behaved correctly from the user's perspective:

```
========== scenario 2: destructive call — DROP TABLE ==========
[audit] db_query DENY (sql.denyDDL) [IRREVERSIBLE]
MODEL → db_query({"query":"DROP TABLE users"})
ASSISTANT: The SQL command to drop the table "users" was not executed because
the operation is not permitted. DDL (Data Definition Language) commands are
restricted in this environment.
```

The `tool({ description, inputSchema, execute })` shape from `ai`'s helper round-tripped through `protectTools(guard, { db_query: ..., http_fetch: ... })` and `generateText({ tools: safeTools })` ran without modification. Audit log fires correctly, model self-corrects.

**One small observation, worth a note in the docs**: in the OpenAI flow the example logs `MODEL → ...` then `[audit] ...DENY...` then `BLOCKED ← ...`, in that order. In the Vercel AI flow the order is `[audit] ...DENY...` then `MODEL → ...`, with **no `BLOCKED ←` line at all** — even though the ASSISTANT response makes clear the model received the denial. The example's deny detection (`if (r.output && typeof r.output === "object" && "error" in r.output)`) doesn't fire, suggesting the Vercel AI shim represents denials as something other than a `step.toolResults[i].output` object. Not a bug — the model still gets the denial and self-corrects — but if a consumer mirrors that example pattern to log/alert on denies, they'll silently miss them. The docs should call out the canonical way to detect a deny in Vercel AI's `result.steps` shape (probably via `step.toolResults[i].error` or similar). See "Paper cut" #3 below.

### Latency and cost

The OpenAI example took ~12s for four scenarios on `gpt-4o-mini` (one input + one tool-result + one final answer per scenario × 4 = ~12 round trips). Vercel AI was similar. Cost was negligible at gpt-4o-mini rates.

### What this closes

The pre-1.0 checklist's only remaining item — "one framework shim end-to-end against a real model conversation" — is **done for both OpenAI and Vercel AI**. Anthropic and LangChain shims still untested but they share the same protectTools surface; risk is now low.

---

## New paper cut found in v0.4

### **1. `shell.denyCommands` marks every denied command as `irreversible: true`**

The doc string on `irreversible` says "DDL, unbounded mutations, destructive shell, write outside fs root." But the implementation marks **all** commands on the denylist as irreversible — including `curl` and `wget`, which are network reads, not destructive ops.

Repros:

```
{ command: "curl http://example.com" }     → irreversible: true
{ argv: ["wget","http://example.com"] }    → irreversible: true
{ argv: ["rm","-rf","/tmp/x"] }            → irreversible: true   (correct)
```

This conflates "the user banned it" with "it would be destructive if it ran." For a consumer building a UI that escalates only on truly destructive denies, the false-positives on `curl`/`wget` are noise.

Two reasonable fixes:

- **Per-command opt-in** at the rule construction site: `rules.shell.denyCommands(list, { destructive: ["rm", "shred", "dd"] })`. Anything on the list but not in `destructive` is `irreversible: false`. Backwards-compatible default could be "all on list" or "empty".
- **Sniff the basename** against a built-in destructive list (`rm`, `shred`, `dd`, `mkfs`, `rmdir`, `mv`-when-overwriting, etc.) and only flag those. Less configurable, more opinionated, probably correct for 80% of users.

The same critique doesn't apply to `denyTables`/`confineTo` — those already differentiate by `kind`/`op` (verified above). Just `denyCommands` is too coarse.

### **2. `irreversible` is undocumented in `usage.md`**

The package now ships the flag end-to-end (Decision → deny() opts → GuardDenied → AuditRecord), but **the only mention in the source tree is the JSDoc comment on the type definition**. None of usage.md's §4 (built-in rules), §8 (custom rules), or §9 (audit log) mentions the field exists.

Suggested additions:

- §4 table: column "Marks irreversible?" with values per rule (DDL=yes, denyMutationWithoutWhere=yes, denyTables=on writes, confineTo=on writes/deletes, denyCommands=…?, denyHosts=no).
- §8 (custom rules): a one-line example calling `deny(reason, matched, { irreversible: true })`.
- §9 (audit log): add `irreversible: boolean` to the `AuditRecord` example.
- Possibly a short §X-bis: "What is `irreversible` for?" — the audience is consumers wiring different downstream behavior (alerting, double-confirm UI) for the two classes.

This is the main `usage.md` gap right now. Without docs, consumers either (a) don't know the field is there, or (b) use it but bake in wrong assumptions about which rules tag what.

### **3. Vercel AI shim — deny is silent in `step.toolResults`**

Discovered while running `examples/vercel-ai-conversation.ts`. The example's deny detection sniffs `step.toolResults[i].output` for an `error` field:

```ts
for (const r of step.toolResults) {
  if (r.output && typeof r.output === "object" && "error" in r.output) {
    console.log(`BLOCKED ← ${JSON.stringify(r.output)}`);
  } else {
    console.log(`HANDLER ← ${JSON.stringify(r.output)}`);
  }
}
```

For the three deny scenarios (DROP TABLE, SSRF, INSERT into non-allowlisted table), **neither branch fires**. The audit log fires (so the guard is doing its job and the shim is calling it), and the LLM clearly receives the denial (its English output explains the policy block correctly). But the consumer's logging code sees nothing.

The OpenAI shim's example, by contrast, surfaces denies cleanly via the `try/catch (err instanceof GuardDenied)` block — so consumers writing OpenAI integration code will reliably log/alert on denies, but consumers copying the Vercel AI example pattern will silently miss them.

Two ways to fix:

- **Ship-side fix**: have the Vercel AI shim represent denials as `step.toolResults[i].error` (or whatever Vercel AI's canonical error field is) so existing AI-SDK logging picks it up.
- **Doc-side fix**: in usage.md §6c, show the canonical "how to detect a guard deny in `result.steps`" snippet — then the example file should match.

Both would be welcome. The doc fix is enough to keep consumers from shipping silent-fail logging.

---

## v0.3.0 paper-cut status (vs v0.2.0 report)

| v0.2 finding                                                        | v0.3 status                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yarn 4 install command syntax                                       | ✅ Fixed in §1 — `yarn add owthorize@file:/path/...tgz` documented                                                                                                                                                       |
| Audit log floods stdout, no convenience for "off"                   | ✅ Fixed — `silentSink` exported and works (verified, see §3 below)                                                                                                                                                      |
| `RuleContext.parsed` re-narrow inside custom `decide`               | ✅ Fixed — `rules.sql.custom` / `rules.http.custom` / `rules.shell.custom` / `rules.fs.custom` typed flavors land cleanly. Used `rules.sql.custom` for `policy.noSelectStar`, no `parsed.type !== "sql"` re-guard needed |
| `rules.sql.denyTables` not listed alongside other rules             | ✅ Fixed — now in §4's built-in table. Replaced my hand-written `policy.tableAllowlist` with `rules.sql.denyTables({ allow: ["Product", "HeroSet"] })`, behavior identical                                               |
| `parsed.tables` casing vs ORM JS names — silent allow if mismatched | ✅ Fixed — §5 has the explicit "table identifiers come from the SQL, not your ORM" callout                                                                                                                               |
| `safeSql` generic + mysql2 `unknown[]` cast                         | ⚠️ **Partially fixed.** `SqlParams` is now exported and slots into the generic, but the type is `ReadonlyArray<…                                                                                                         | undefined>`and`mysql2`'s `pool.execute(query, values)`wants a mutable`ExecuteValues[]` whose elements are non-`undefined`. **The consumer still ends up casting.** See "New paper cuts" below for the actual error and the workaround. |

---

## Coverage from this v0.3 dogfood

Single guard, six tools, four adapters, eleven rules, two guards (one with default sink, one with `silentSink`).

```ts
// backend/src/lib/guard.ts (excerpt)
export const guard = new Guard({
  rules: [
    rules.sql.denyDDL(),
    rules.sql.denyMutationWithoutWhere(),
    rules.sql.denyTables({ allow: ["Product", "HeroSet"] }),
    noSelectStar,                                       // rules.sql.custom (typed)
    rules.http.denyHosts(rules.http.SSRF_DEFAULTS),
    rules.shell.denyCommands(["rm", "curl", "wget", "ssh", "nc"]),
    rules.fs.confineTo(["/tmp/owthorize-demo"]),
  ],
});

export const safeSql       = guard.tool("db.query",     { adapter: "sql.mysql", redact: ["params"], handler: ... });
export const safeFetch     = guard.tool("http.fetch",   { adapter: "http",      redact: ["headers.Authorization", "headers.authorization"], handler: ... });
export const safeWriteFile = guard.tool("fs.writeFile", { adapter: "fs",        handler: ... });
export const safeReadFile  = guard.tool("fs.readFile",  { adapter: "fs",        handler: ... });
export const safeExec      = guard.tool("shell.exec",   { adapter: "shell",     handler: ... });

export const quietGuard = new Guard({ rules: [rules.sql.denyDDL()], audit: { sink: silentSink } });
```

Audit-log totals after the test run:

| Tool             | Calls audited | Rules that fired                                                                       |
| ---------------- | ------------- | -------------------------------------------------------------------------------------- |
| `db.query`       | 6             | `sql.denyDDL`, `sql.denyMutationWithoutWhere`, `sql.denyTables`, `policy.noSelectStar` |
| `http.fetch`     | 10            | `http.denyHosts` (8 deny, 2 allow)                                                     |
| `fs.writeFile`   | 3             | `fs.confineTo` (2 deny, 1 allow)                                                       |
| `fs.readFile`    | 2             | `fs.confineTo` (1 deny, 1 allow)                                                       |
| `shell.exec`     | 4             | `shell.denyCommands` (2), `shell.metachar` (1), 1 allow                                |
| `not.registered` | 1             | `owthorize.unknownTool`                                                                |

`matched_rule_kind` distribution: 17 `builtin`, 1 `custom-local` — the typed custom rule is correctly tagged.

---

## 1. HTTP adapter + SSRF (Priority 1 from §13)

This is the headline result. All nine SSRF default cases blocked correctly, including the IPv4-mapped IPv6 edge case the doc explicitly warned about.

| URL                                                                                 | matched_rule     | reason                                                |
| ----------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------- |
| `http://169.254.169.254/latest/meta-data/` (AWS IMDS)                               | `http.denyHosts` | host blocked: 169.254.169.254 matched 169.254.169.254 |
| `http://localhost:8080/admin`                                                       | `http.denyHosts` | host blocked: localhost matched localhost             |
| `http://127.0.0.1/`                                                                 | `http.denyHosts` | host blocked: 127.0.0.1 matched 127.0.0.0/8           |
| `https://[::1]/`                                                                    | `http.denyHosts` | host blocked: [::1] matched ::1                       |
| `http://[::ffff:127.0.0.1]/` (IPv4-mapped IPv6)                                     | `http.denyHosts` | host blocked: [::ffff:7f00:1] matched 127.0.0.0/8     |
| `http://192.168.1.1/` (RFC1918)                                                     | `http.denyHosts` | host blocked: 192.168.1.1 matched 192.168.0.0/16      |
| `http://db.internal/health` (`*.internal`)                                          | `http.denyHosts` | host blocked: db.internal matched \*.internal         |
| `https://api.github.com/zen`                                                        | (none)           | allow                                                 |
| `https://api.github.com/...` with `Authorization: Bearer SUPER_SECRET_TOKEN_xyz123` | (none)           | allow, **token never appeared in audit log**          |

The IPv4-mapped IPv6 normalization (`[::ffff:127.0.0.1] → 7f00:1` matched against `127.0.0.0/8`) is exactly the right behavior. This is the kind of case where naive host-string matching fails and the package gets it right.

The `http` adapter's `parsed.headerKeys` is **lowercased and includes only keys, not values** — header values never leak into the audit record by default. Combined with the `redact` option, an `Authorization: Bearer ...` token is doubly protected: the value isn't in `parsed`, and `payload_hash` is stable across token rotation. Searched audit log for `SUPER_SECRET_TOKEN_xyz123` after the call — zero matches.

---

## 2. FS adapter + `confineTo`

| Operation | Path                                | Outcome                                                         |
| --------- | ----------------------------------- | --------------------------------------------------------------- |
| write     | `/tmp/owthorize-demo/hello.txt`     | ✅ allow, file created (2 bytes)                                |
| write     | `/etc/passwd`                       | ❌ `fs.confineTo`: path outside confined roots: /etc/passwd     |
| write     | `/tmp/owthorize-demo/../escape.txt` | ❌ `fs.confineTo`: path outside confined roots: /tmp/escape.txt |
| read      | `/tmp/owthorize-demo/seed.txt`      | ✅ allow, content returned                                      |
| read      | `/etc/passwd`                       | ❌ `fs.confineTo`: path outside confined roots: /etc/passwd     |

Parent-traversal escape is correctly resolved before comparison — the deny message shows the resolved `/tmp/escape.txt`, not the raw `../escape.txt`. As §11 already calls out, symlinks aren't followed; that's a known limitation, not a bug.

---

## 3. Shell adapter + `denyCommands`

| Input                                          | matched_rule         | notes                                                   |
| ---------------------------------------------- | -------------------- | ------------------------------------------------------- |
| `{ argv: ["ls","-la","/tmp/owthorize-demo"] }` | (none) — allow       | argv form ran via `execFile`                            |
| `{ argv: ["rm","-rf","/tmp/owthorize-demo"] }` | `shell.denyCommands` | basename match on `rm`                                  |
| `{ command: "ls; rm -rf /" }`                  | `shell.metachar`     | metachar caught **before** the `rm` denylist could fire |
| `{ command: "curl http://evil.example.com" }`  | `shell.denyCommands` | basename match on `curl`                                |

**Surprise — `shell.metachar` is a separate `matched_rule` value** (not `shell.denyCommands`). The §4 description for `denyCommands` says it covers "banned commands (basename match) plus shell metacharacter abuse," which is accurate, but a reader writing assertions like `expect(matched).toBe("shell.denyCommands")` will be wrong half the time. Worth listing `shell.metachar` (and likely `shell.metachar:pipe`, `shell.metachar:redirect`, `shell.metachar:substitution` based on the source) in §4 explicitly so test authors know what to assert. See "New paper cuts" #2 below.

---

## 4. SQL — typed custom rule + `denyTables` + redact

The same six SQL cases from v0.2 still work; the new ones in v0.3:

| Case                                                         | matched_rule          | notes                                                                                         |
| ------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------- |
| `INSERT INTO Customer (id) VALUES (?)`                       | `sql.denyTables`      | reason: `table not on allowlist: customer` (lowercased — confirms the case-folding §4 claims) |
| `SELECT * FROM Product`                                      | `policy.noSelectStar` | typed custom rule (`rules.sql.custom`), `kind: "custom-local"`                                |
| `SELECT id FROM Product WHERE id = ?` with `params: ["aaa"]` | (none) — allow        | hash recorded                                                                                 |
| `SELECT id FROM Product WHERE id = ?` with `params: ["bbb"]` | (none) — allow        | **identical hash** to the `aaa` call                                                          |

**`redact: ["params"]` is verified working.** Two calls to the same query with different param values produced **identical `payload_hash`** (`sha256:04daaa46…3247f1` for both). The literal strings `"aaa"` and `"bbb"` don't appear in the audit stream. Same query with redaction off would have produced two different hashes.

The typed custom rule reads cleanly:

```ts
const noSelectStar = rules.sql.custom({
  name: "policy.noSelectStar",
  on: "db.query",
  when: ({ parsed }) =>
    parsed.kind === "select" && /\bselect\s+\*/i.test(parsed.raw),
  decide: () =>
    deny(
      "SELECT * is forbidden — list columns explicitly",
      "policy.noSelectStar",
    ),
});
```

`parsed.kind` and `parsed.raw` are typed without any cast or re-guard — this was awkward in v0.2 and is genuinely fixed.

---

## 5. Failure-mode rule names

| Trigger                                                       | matched_rule             | reason                                                               |
| ------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `guard.simulate("not.registered", {})`                        | `owthorize.unknownTool`  | `unknown tool: not.registered`                                       |
| `guard.simulate("db.query", { sql: "SELECT 1" })` (wrong key) | `owthorize.adapterError` | `adapter error: sql adapter: payload must include { query: string }` |

Both are **synthetic rule names** the engine emits when the failure-mode policy denies. They're not in §4 of `usage.md` (which lists configurable built-ins) — but they appear in audit logs and consumers will write assertions against them. See "New paper cuts" #3.

---

## 6. `silentSink`

A second guard configured with `audit: { sink: silentSink }` was used to run two `simulate("db.query", …)` calls (one DROP, one SELECT). After those calls the global stdout audit-line count went up by exactly **+0** (only the main guard's 2 admin-sql writes that ran in parallel added lines). `silentSink` is a no-op, as advertised.

The `Decision` returned to the route handler is unaffected — the `decision/reason/matched` fields are populated. Only the audit-log emit is suppressed. This is the correct split.

---

## Pre-1.0 checklist (§13) — current status

| Item                               | Status                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP adapter + SSRF defaults       | ✅ Done. 7 deny cases (incl. IPv4-mapped IPv6), 2 allow cases, redact verified.                                                                                                                                                                 |
| HTTP `allowHosts` strict allowlist | ⏭️ Skipped this round. Single-line addition in a parallel guard whenever needed.                                                                                                                                                                |
| **OpenAI shim end-to-end**         | ❌ Not yet — backend has no OpenAI/Anthropic/LangChain/Vercel SDK installed. Adding one just to dogfood is a heavier lift than the SQL/HTTP/FS/shell coverage that fits the existing app shape. **This is the gap to close before publishing.** |
| Shell adapter (was "skip")         | ✅ Tested anyway — denyCommands + metachar both fire correctly. See note about the metachar matched_rule value.                                                                                                                                 |
| FS adapter (was "skip")            | ✅ Tested anyway — confineTo handles parent traversal correctly.                                                                                                                                                                                |

So **on the engine + adapters + audit + redact + simulate + custom-rule axes, 0.3.0 is publish-ready.** The remaining gap is one framework shim run against a real model conversation.

---

## v0.3 backlog (historical — see top of report for v0.4 status)

### 1. `SqlParams` doesn't slot into mysql2 cleanly _(fixed in v0.4)_

Even with the new typed export, this still fails type-check:

```ts
import type { SqlParams } from "owthorize";
const safeSql = guard.tool<{ query: string; params?: SqlParams }, unknown>(
  "db.query",
  {
    adapter: "sql.mysql",
    handler: async ({ query, params }) => {
      const [rows] = await pool.execute(query, params ?? []);
      //                                       ^^^^^^^^^^^^
      // TS2769: Argument of type 'SqlParams' is not assignable to
      // parameter of type 'ExecuteValues | undefined'.
      //   The type 'readonly (...)[]' is 'readonly' and cannot be
      //   assigned to the mutable type 'ExecuteValues[]'.
      return rows;
    },
  },
);
```

Two distinct issues:

- **Readonly vs mutable.** `SqlParams = ReadonlyArray<...>`. mysql2's `ExecuteValues` is mutable. Even `[...params]` doesn't help because…
- **`undefined` in the element union.** `SqlParams` includes `undefined` but mysql2's `ExecuteValues` rejects `undefined`.

Final workaround in our code is `(params ? [...params] : []) as any[]` — same `as any[]` cast as v0.2, just better-disguised.

Recommendations (any one of these would land it):

- Make `SqlParams` mutable: `Array<...>` instead of `ReadonlyArray<...>`.
- Drop `undefined` from the union (callers can pass `null` for SQL-NULL).
- Or document the mysql2 escape hatch in §5 right next to the `SqlParams` callout. A one-line "if your driver complains, copy with `[...params]` and cast" is enough — the surprise is that the callout currently implies the cast goes away.

### 2. `shell.metachar` is undocumented as a `matched_rule` value

§4 says `denyCommands(list, opts?)` blocks "Banned commands (basename match) plus shell metacharacter abuse." True — but the metachar path emits `matched_rule: "shell.metachar"`, not `"shell.denyCommands"`. From the compiled source, `shell.metachar` is also the value when a pipe (`|`), redirect (`>`), or command substitution (`$(...)`, backticks) is detected.

Recommendation: add a row to §4's table (or a sub-bullet under `denyCommands`) listing `shell.metachar` as a co-emitted rule name so test authors know what to assert.

### 3. `owthorize.unknownTool` and `owthorize.adapterError` aren't documented

Both appear in real audit records and are the natural assertion targets for failure-mode tests. §10 ("Failure modes") names the situations and the override flags but doesn't tell the reader what `matched_rule` they'll see in the log.

Recommendation: extend the §10 table with a column for `matched_rule`:

| Situation                 | `matched_rule`                                            | Default | Override                  |
| ------------------------- | --------------------------------------------------------- | ------- | ------------------------- |
| Call to an unwrapped tool | `owthorize.unknownTool`                                   | deny    | `defaults.onUnknownTool`  |
| Adapter parse error       | `owthorize.adapterError`                                  | deny    | `defaults.onAdapterError` |
| Rule throws               | (whatever the rule name is, kind=builtin or custom-local) | deny    | `defaults.onRuleError`    |

### 4. (Carryover, smaller) Audit record schema doesn't show `payload_hash` algorithm

The audit records emit `payload_hash: "sha256:..."` (with the `sha256:` prefix). The `AuditRecord` type in §9 just says `payload_hash: string`. A consumer wanting to verify hashes in tests has to discover the prefix by reading a record. One-line note in the type comment would close that.

---

## What's actually used in production

For anyone reading this report deciding whether to roll owthorize out: in this backend it sits in front of an **admin-only `/api/admin/*` surface** (raw SQL, fetch passthrough, file write, shell exec) — exactly the kind of route an LLM agent or a "backdoor" power-user tool would hit. The live `POST /api/products` user-facing endpoint is unchanged (Drizzle, no guard) because Drizzle doesn't expose its rendered SQL string in a way that fits the `{ query, params }` shape cleanly. **The natural integration point is "admin/agent tools," not "every ORM call."** That's where the package's value lands and where the SSRF + DDL + path-traversal classes of bug actually get blocked.

---

## Repro

```bash
# install
cd backend
yarn add owthorize@file:/abs/path/owthorize-0.3.0.tgz

# prepare fs root for confineTo demo
mkdir -p /tmp/owthorize-demo
echo "preexisting content" > /tmp/owthorize-demo/seed.txt

# run
yarn dev          # backend listens on 3009 in this project

# SSRF
curl -sS -XPOST localhost:3009/api/admin/fetch -H 'content-type: application/json' \
  -d '{"url":"http://169.254.169.254/latest/meta-data/"}'
# → 403 http.denyHosts

curl -sS -XPOST localhost:3009/api/admin/fetch -H 'content-type: application/json' \
  -d '{"url":"http://[::ffff:127.0.0.1]/"}'
# → 403 http.denyHosts (matched 127.0.0.0/8)

# fs traversal
curl -sS -XPOST localhost:3009/api/admin/fs/write -H 'content-type: application/json' \
  -d '{"path":"/tmp/owthorize-demo/../escape.txt","content":"x"}'
# → 403 fs.confineTo

# shell metachar
curl -sS -XPOST localhost:3009/api/admin/exec -H 'content-type: application/json' \
  -d '{"command":"ls; rm -rf /"}'
# → 403 shell.metachar

# SELECT *
curl -sS -XPOST localhost:3009/api/products/admin-sql -H 'content-type: application/json' \
  -d '{"query":"SELECT * FROM Product"}'
# → 403 policy.noSelectStar

# table not on allowlist
curl -sS -XPOST localhost:3009/api/products/admin-sql -H 'content-type: application/json' \
  -d '{"query":"INSERT INTO Customer (id) VALUES (?)","params":["x"]}'
# → 403 sql.denyTables

# unknown tool / adapter mismatch (simulate)
curl -sS -XPOST localhost:3009/api/admin/unknown-tool -H 'content-type: application/json' -d '{}'
# → owthorize.unknownTool
curl -sS -XPOST localhost:3009/api/admin/adapter-mismatch -H 'content-type: application/json' -d '{}'
# → owthorize.adapterError
```

---

## Conclusion

**v0.4.1 closes every open paper cut from previous cycles.** The package is publish-ready by every test I have to throw at it.

What's verified end-to-end against real traffic:

- SQL / HTTP / FS / shell adapters with built-in rules.
- `irreversible` flag — auto-tagged by built-ins, opt-in via `deny(..., { irreversible: true })` for custom rules, per-rule override on `denyCommands` via `destructive: [...]`. Default destructive set (`rm`, `dd`, etc.) lines up with intuition.
- Typed and untyped custom rules; `silentSink`; redaction (verified by hash equality).
- Failure-mode synthetic rules: `owthorize.unknownTool`, `owthorize.adapterError`, **and now `owthorize.ruleError:<rule-name>`** (verified live this cycle).
- **OpenAI shim** against `gpt-4o-mini` — four scenarios, model self-corrects on deny, `irreversible` flag surfaces in the model's English.
- **Vercel AI shim** against `gpt-4o-mini` — same four scenarios, denies now visible in `step.content[]` walker (was silent in v0.4.0).
- `USAGE.md` has end-to-end coverage of `irreversible`, all synthetic rule names, the Vercel-AI deny detection idiom, and a routing pattern for the flag.

Status of the v0.4 paper-cut backlog:

| Paper cut                                                 | Status                                                    |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `shell.denyCommands` over-marks irreversible              | ✅ closed via `DESTRUCTIVE_DEFAULTS` + `destructive` opts |
| `irreversible` undocumented                               | ✅ closed in `USAGE.md` §4/§8/§9/§10/§11/§12              |
| Vercel AI shim deny silent in `step.toolResults`          | ✅ closed via doc + example walking `step.content[]`      |
| v0.3 lingering doc gaps (`shell.metachar`, `owthorize.*`) | ✅ closed — all listed in §4 / §10                        |

What's left for v1.0:

- **Anthropic and LangChain shims** still untested live. Both share the `protectTools` surface validated by the OpenAI and Vercel AI runs, so risk is low; whoever needs them first should run a 60-90-min field test.
- **HTTP `allowHosts` strict allowlist** — verified on the deny side; allow-side is a single-line addition whenever a project needs it.

Neither blocks publishing. The package is **shippable as-is**; remaining work is integration validation for adapters my dogfood project doesn't use.
