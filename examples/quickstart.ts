// In your project use: import { Guard, rules } from "owthorize"
import { Guard, rules } from "../src/index"
import type { AuditRecord } from "../src/audit"

const guard = new Guard({
  rules: [
    rules.sql.denyDDL(),
    rules.sql.denyMutationWithoutWhere(),
    rules.sql.denyTables({ deny: ["audit_log"] }),
    rules.http.denyHosts(rules.http.SSRF_DEFAULTS),
    rules.shell.denyCommands(["rm", "curl", "wget", "nc", "ssh"]),
    rules.fs.confineTo(["/tmp/agent-workspace"]),
  ],
  audit: {
    sink: (r: AuditRecord) => {
      console.log("[audit]", r.tool, r.decision, r.matched_rule ?? "")
    },
  },
})

const safeQuery = guard.tool<{ query: string; params?: unknown }, { rows: unknown[] }>(
  "db.query",
  {
    adapter: "sql.postgres",
    handler: async ({ query }: { query: string }) => ({ rows: [{ query }] }),
  },
)

const safeFetch = guard.tool<{ url: string; method?: string }, { ok: boolean; url: string }>(
  "http.fetch",
  {
    adapter: "http",
    handler: async ({ url }: { url: string }) => ({ ok: true, url }),
  },
)

async function main(): Promise<void> {
  console.log("---- simulate (no side effects) ----")
  console.log(guard.simulate("db.query", { query: "DROP TABLE users" }))
  console.log(guard.simulate("db.query", { query: "DELETE FROM users" }))
  console.log(guard.simulate("db.query", { query: "INSERT INTO audit_log (e) VALUES ('x')" }))
  console.log(guard.simulate("http.fetch", { url: "http://169.254.169.254/" }))
  console.log(guard.simulate("db.query", { query: "SELECT id FROM users WHERE id = 1" }))

  console.log("\n---- live calls ----")
  try {
    await safeQuery({ query: "DROP TABLE users" })
  } catch (err) {
    console.log("blocked:", (err as Error).message)
  }

  const ok = await safeQuery({ query: "SELECT id FROM users WHERE id = 1" })
  console.log("allowed:", ok)

  try {
    await safeFetch({ url: "http://169.254.169.254/" })
  } catch (err) {
    console.log("blocked:", (err as Error).message)
  }

  const ok2 = await safeFetch({ url: "https://api.openai.com/v1/models" })
  console.log("allowed:", ok2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
