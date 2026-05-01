import { registerAdapter } from "./registry"
import type { Adapter, HttpParsed } from "./types"

interface HttpPayload {
  url: string
  method?: string
  headers?: Record<string, string | string[] | undefined> | Headers | Array<[string, string]>
  body?: unknown
}

function isHttpPayload(p: unknown): p is HttpPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    "url" in p &&
    typeof (p as { url: unknown }).url === "string"
  )
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"])

export function makeHttpAdapter(): Adapter {
  return {
    name: "http",
    parse(payload): HttpParsed {
      if (!isHttpPayload(payload)) {
        throw new Error("http adapter: payload must include { url: string }")
      }
      const raw = payload.url
      if (!raw.trim()) {
        throw new Error("http adapter: empty url")
      }

      let url: URL
      try {
        url = new URL(raw)
      } catch {
        throw new Error(`http adapter: invalid url: ${raw}`)
      }

      if (!ALLOWED_SCHEMES.has(url.protocol)) {
        throw new Error(`http adapter: unsupported scheme: ${url.protocol}`)
      }

      const host = url.hostname
      const hostNormalized = normalizeHost(host)
      const port = url.port === "" ? null : Number(url.port)
      const method = (payload.method ? String(payload.method) : "GET").toUpperCase()
      const path = url.pathname || "/"

      return {
        type: "http",
        method,
        url: rebuildUrlSafe(url),
        host,
        hostNormalized,
        port,
        path,
        query: collectQuery(url.searchParams),
        headerKeys: collectHeaderKeys(payload.headers),
        bodySize: computeBodySize(payload.body),
      }
    },
  }
}

function normalizeHost(host: string): string {
  let h = host
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1)
  const pct = h.indexOf("%")
  if (pct !== -1) h = h.slice(0, pct)
  if (h.endsWith(".")) h = h.slice(0, -1)
  return h.toLowerCase()
}

function rebuildUrlSafe(url: URL): string {
  if (!url.username && !url.password) return url.toString()
  const u = new URL(url.toString())
  u.username = ""
  u.password = ""
  return u.toString()
}

function collectQuery(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key)
    out[key] = all.length === 1 ? all[0] : all
  }
  return out
}

function collectHeaderKeys(headers: HttpPayload["headers"]): string[] {
  if (!headers) return []
  const set = new Set<string>()
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((_v, k) => set.add(k.toLowerCase()))
  } else if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length > 0) set.add(String(pair[0]).toLowerCase())
    }
  } else if (typeof headers === "object") {
    for (const k of Object.keys(headers)) set.add(k.toLowerCase())
  }
  return [...set].sort()
}

function computeBodySize(body: unknown): number {
  if (body == null) return 0
  if (typeof body === "string") return Buffer.byteLength(body, "utf8")
  if (body instanceof Uint8Array) return body.byteLength
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return body.byteLength
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size
  if (typeof body === "object") {
    try {
      return Buffer.byteLength(JSON.stringify(body), "utf8")
    } catch {
      return 0
    }
  }
  return 0
}

registerAdapter(makeHttpAdapter())
