import picomatch from "picomatch"
import type { HttpParsed } from "../adapters/types"
import { deny } from "../decision"
import { makeTypedCustom } from "./_typed-custom"
import type { Rule } from "./types"

export const custom = makeTypedCustom<HttpParsed>("http")

export const SSRF_DEFAULTS: readonly string[] = Object.freeze([
  "localhost",
  "127.0.0.0/8",
  "::1",
  "0.0.0.0",
  "169.254.169.254",
  "169.254.0.0/16",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
  "fe80::/10",
  "*.internal",
  "*.local",
  "*.localhost",
])

interface CompiledPattern {
  raw: string
  match: (host: string) => boolean
}

export function denyHosts(list: readonly string[]): Rule {
  const compiled = compilePatterns(list)
  return {
    name: "http.denyHosts",
    kind: "builtin",
    evaluate(ctx) {
      const parsed = ctx.parsed
      if (parsed.type !== "http") return
      const host = parsed.hostNormalized
      for (const p of compiled) {
        if (p.match(host)) {
          return deny(`host blocked: ${parsed.host} matched ${p.raw}`, "http.denyHosts")
        }
      }
    },
  }
}

export function allowHosts(list: readonly string[]): Rule {
  const compiled = compilePatterns(list)
  return {
    name: "http.allowHosts",
    kind: "builtin",
    evaluate(ctx) {
      const parsed = ctx.parsed
      if (parsed.type !== "http") return
      const host = parsed.hostNormalized
      for (const p of compiled) {
        if (p.match(host)) return
      }
      return deny(`host not on allowlist: ${parsed.host}`, "http.allowHosts")
    },
  }
}

function compilePatterns(list: readonly string[]): CompiledPattern[] {
  if (!list || list.length === 0) {
    throw new Error("http rules: pattern list must not be empty")
  }
  return list.map(compilePattern)
}

function compilePattern(p: string): CompiledPattern {
  if (typeof p !== "string" || !p.trim()) {
    throw new Error(`http rules: invalid host pattern: ${String(p)}`)
  }
  const pat = p.toLowerCase().trim()

  if (pat.includes("/")) return compileCidr(pat)
  if (pat.includes("*")) {
    const m = picomatch(pat, { nocase: true, dot: true })
    return { raw: p, match: (h) => m(h) }
  }
  return { raw: p, match: (h) => h === pat }
}

function compileCidr(pat: string): CompiledPattern {
  const [addr, bitsStr] = pat.split("/")
  const bits = Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0) {
    throw new Error(`http rules: invalid CIDR prefix: ${pat}`)
  }

  if (addr.includes(":")) {
    if (bits > 128) throw new Error(`http rules: invalid IPv6 CIDR: ${pat}`)
    const network = ipv6ToBigInt(addr)
    if (network === null) throw new Error(`http rules: invalid IPv6 in CIDR: ${pat}`)
    const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n)
    const masked = network & mask
    return {
      raw: pat,
      match: (h) => {
        const v6 = ipv6ToBigInt(h) ?? mappedV4ToV6(h)
        if (v6 === null) return false
        return (v6 & mask) === masked
      },
    }
  }

  if (bits > 32) throw new Error(`http rules: invalid IPv4 CIDR: ${pat}`)
  const network = ipv4ToUint32(addr)
  if (network === null) throw new Error(`http rules: invalid IPv4 in CIDR: ${pat}`)
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  const masked = (network & mask) >>> 0

  return {
    raw: pat,
    match: (h) => {
      let v4 = ipv4ToUint32(h)
      if (v4 === null) v4 = mappedV6ToV4Uint32(h)
      if (v4 === null) return false
      return (v4 & mask) >>> 0 === masked
    },
  }
}

function ipv4ToUint32(s: string): number | null {
  const parts = s.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

function ipv6ToBigInt(s: string): bigint | null {
  const at = s.indexOf("%")
  const clean = at === -1 ? s : s.slice(0, at)
  if (!clean.includes(":")) return null

  const lastDot = clean.lastIndexOf(".")
  if (lastDot !== -1) {
    const colonBeforeDot = clean.lastIndexOf(":", lastDot)
    if (colonBeforeDot === -1) return null
    const v4Part = clean.slice(colonBeforeDot + 1)
    const v4n = ipv4ToUint32(v4Part)
    if (v4n === null) return null
    const hexHi = ((v4n >>> 16) & 0xffff).toString(16)
    const hexLo = (v4n & 0xffff).toString(16)
    return ipv6ToBigInt(`${clean.slice(0, colonBeforeDot + 1)}${hexHi}:${hexLo}`)
  }

  let parts: string[]
  if (clean.includes("::")) {
    const segments = clean.split("::")
    if (segments.length !== 2) return null
    const headParts = segments[0] ? segments[0].split(":") : []
    const tailParts = segments[1] ? segments[1].split(":") : []
    const fillCount = 8 - headParts.length - tailParts.length
    if (fillCount < 0) return null
    parts = [...headParts, ...new Array(fillCount).fill("0"), ...tailParts]
  } else {
    parts = clean.split(":")
  }
  if (parts.length !== 8) return null

  let n = 0n
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null
    n = (n << 16n) | BigInt(Number.parseInt(p, 16))
  }
  return n
}

function mappedV6ToV4Uint32(host: string): number | null {
  if (!host.includes(":")) return null
  const big = ipv6ToBigInt(host)
  if (big === null) return null
  const upper = big >> 32n
  if (upper === 0xffffn) return Number(big & 0xffffffffn)
  return null
}

function mappedV4ToV6(host: string): bigint | null {
  const v4 = ipv4ToUint32(host)
  if (v4 === null) return null
  return (0xffffn << 32n) | BigInt(v4)
}
