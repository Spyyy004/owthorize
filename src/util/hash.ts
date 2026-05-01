import { createHash } from "node:crypto"

export function hashPayload(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(input)).digest("hex")}`
}

function canonicalize(v: unknown): string {
  if (v === undefined) return "null"
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) {
    return `[${v.map(canonicalize).join(",")}]`
  }
  const keys = Object.keys(v as Record<string, unknown>).sort()
  const obj = v as Record<string, unknown>
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`
}
