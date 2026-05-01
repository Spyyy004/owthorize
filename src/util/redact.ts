export const REDACTED = "[REDACTED]"

export function redactPaths(input: unknown, paths: string[]): unknown {
  const cloned = cloneDeep(input)
  if (paths.length === 0) return cloned
  for (const p of paths) {
    redactPath(cloned, p.split("."))
  }
  return cloned
}

function cloneDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v
  return structuredClone(v)
}

function redactPath(obj: unknown, parts: string[]): void {
  if (obj === null || obj === undefined) return
  const [head, ...rest] = parts
  if (head === undefined) return

  if (head === "*") {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (rest.length === 0) obj[i] = REDACTED
        else redactPath(obj[i], rest)
      }
      return
    }
    if (typeof obj === "object") {
      const o = obj as Record<string, unknown>
      for (const k of Object.keys(o)) {
        if (rest.length === 0) o[k] = REDACTED
        else redactPath(o[k], rest)
      }
    }
    return
  }

  if (Array.isArray(obj)) {
    const idx = Number(head)
    if (!Number.isInteger(idx) || idx < 0 || idx >= obj.length) return
    if (rest.length === 0) obj[idx] = REDACTED
    else redactPath(obj[idx], rest)
    return
  }

  if (typeof obj !== "object") return
  const o = obj as Record<string, unknown>
  if (!(head in o)) return
  if (rest.length === 0) o[head] = REDACTED
  else redactPath(o[head], rest)
}
