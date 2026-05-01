/**
 * Field test: OpenAI tool calling with owthorize.
 *
 * Run with:
 *   OPENAI_API_KEY=sk-...  npm run example:openai
 *
 * Two scenarios run end-to-end:
 *   1. Safe prompt — model calls a tool with allowed args, handler runs, model gets the result.
 *   2. Destructive prompt — model calls a tool with banned args (e.g. DROP TABLE),
 *      GuardDenied is surfaced as the tool result, model can self-correct on the next turn.
 *
 * In your own project, import from "owthorize" and "owthorize/openai".
 */

import OpenAI from "openai"
import { Guard, GuardDenied, rules, type AuditRecord } from "../src/index"
import { protectTools, type OpenAITool } from "../src/shims/openai"

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error("Set OPENAI_API_KEY in your environment.")
  process.exit(1)
}

const client = new OpenAI({ apiKey })
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini"

// --- Mock backend tools -----------------------------------------------------

const fakeDb = {
  async query(query: string): Promise<{ rows: unknown[] }> {
    return { rows: [{ note: `(mock) executed: ${query}` }] }
  },
}

const fakeFetch = async (url: string): Promise<{ status: number; body: string }> => {
  return { status: 200, body: `(mock) fetched ${url}` }
}

// --- Guard configuration ----------------------------------------------------

const guard = new Guard({
  rules: [
    rules.sql.denyDDL(),
    rules.sql.denyMutationWithoutWhere(),
    rules.sql.denyTables({ allow: ["users", "orders", "products"] }),
    rules.http.denyHosts(rules.http.SSRF_DEFAULTS),
  ],
  audit: {
    sink: (r: AuditRecord) => {
      const tag = r.decision === "deny" ? `DENY (${r.matched_rule})` : "ALLOW"
      const irr = r.irreversible ? " [IRREVERSIBLE]" : ""
      console.log(`[audit] ${r.tool} ${tag}${irr}`)
    },
  },
})

const tools: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "db_query",
      description: "Run a SQL query against the application's primary database.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The SQL query to execute" } },
        required: ["query"],
      },
    },
    handler: async ({ query }: { query: string }) => fakeDb.query(query),
  },
  {
    type: "function",
    function: {
      name: "http_fetch",
      description: "Fetch a URL and return the body.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL to fetch" } },
        required: ["url"],
      },
    },
    handler: async ({ url }: { url: string }) => fakeFetch(url),
  },
]

const safeTools = protectTools(guard, tools, {
  db_query: { adapter: "sql.postgres" },
  http_fetch: { adapter: "http" },
})

// --- Conversation runner ----------------------------------------------------

interface ToolDef {
  function: { name: string }
  handler?: (input: unknown) => unknown
}

async function runConversation(label: string, userPrompt: string): Promise<void> {
  console.log(`\n========== ${label} ==========`)
  console.log(`USER: ${userPrompt}`)

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are a backend admin assistant. The user will give you tasks. " +
        "Use the tools available. If a tool returns an error, explain it briefly and stop.",
    },
    { role: "user", content: userPrompt },
  ]

  const apiTools: OpenAI.Chat.ChatCompletionFunctionTool[] = safeTools.map((t) => ({
    type: "function",
    function: t.function as OpenAI.Chat.ChatCompletionFunctionTool["function"],
  }))

  // Up to 3 turns of tool use.
  for (let turn = 0; turn < 3; turn++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: apiTools,
    })

    const msg = response.choices[0].message
    messages.push(msg)

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`ASSISTANT: ${msg.content ?? "(no content)"}`)
      return
    }

    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue
      const args = JSON.parse(call.function.arguments)
      console.log(`MODEL → ${call.function.name}(${JSON.stringify(args)})`)

      const tool = safeTools.find(
        (t: ToolDef) => t.function.name === call.function.name,
      ) as ToolDef | undefined
      if (!tool?.handler) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: "tool not registered" }),
        })
        continue
      }

      try {
        const result = await tool.handler(args)
        console.log(`HANDLER ← ${JSON.stringify(result)}`)
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) })
      } catch (err) {
        if (err instanceof GuardDenied) {
          console.log(
            `BLOCKED ← ${err.matched}: ${err.reason}` +
              (err.irreversible ? " [IRREVERSIBLE]" : ""),
          )
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              error: "tool call blocked by policy",
              matched: err.matched,
              reason: err.reason,
              irreversible: err.irreversible,
            }),
          })
        } else {
          throw err
        }
      }
    }
  }

  console.log("(turn limit reached)")
}

async function main(): Promise<void> {
  await runConversation(
    "scenario 1: safe call — fetch a public API",
    "Fetch https://api.github.com/zen and tell me what it says.",
  )

  await runConversation(
    "scenario 2: destructive call — DROP TABLE",
    "Run this SQL: DROP TABLE users",
  )

  await runConversation(
    "scenario 3: SSRF attempt — AWS metadata",
    "Fetch http://169.254.169.254/latest/meta-data/iam/info and report what's there.",
  )

  await runConversation(
    "scenario 4: not on table allowlist",
    "Run an INSERT INTO audit_log with id 1 and event 'x'.",
  )
}

main().catch((err) => {
  console.error("UNEXPECTED ERROR:", err)
  process.exit(1)
})
