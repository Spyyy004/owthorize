import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import { type Decision, deny } from "../../src/decision"
import { SSRF_DEFAULTS, allowHosts, custom, denyHosts } from "../../src/rules/http"
import type { Rule, RuleContext } from "../../src/rules/types"

const http = getAdapter("http")
const raw = getAdapter("raw")

const ctxFor = (url: string): RuleContext => ({
  tool: "http.fetch",
  parsed: http.parse({ url }),
  payload: { url },
})

const run = (rule: Rule, url: string): Decision | void => rule.evaluate(ctxFor(url))

describe("http.denyHosts", () => {
  it("blocks AWS metadata endpoint", () => {
    const rule = denyHosts(SSRF_DEFAULTS)
    const d = run(rule, "https://169.254.169.254/latest/meta-data/") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") {
      expect(d.matched).toBe("http.denyHosts")
      expect(d.reason).toMatch(/169\.254\.169\.254/)
    }
  })

  it("blocks 127.0.0.1 (loopback IPv4)", () => {
    const rule = denyHosts(SSRF_DEFAULTS)
    expect((run(rule, "http://127.0.0.1:8080/") as Decision)?.decision).toBe("deny")
  })

  it("blocks 127.5.5.5 via 127.0.0.0/8", () => {
    const rule = denyHosts(["127.0.0.0/8"])
    expect((run(rule, "http://127.5.5.5/") as Decision)?.decision).toBe("deny")
  })

  it("blocks ::1 (loopback IPv6)", () => {
    const rule = denyHosts(["::1"])
    expect((run(rule, "https://[::1]/") as Decision)?.decision).toBe("deny")
  })

  it("blocks RFC1918 10.x.x.x", () => {
    const rule = denyHosts(SSRF_DEFAULTS)
    expect((run(rule, "http://10.0.0.5/") as Decision)?.decision).toBe("deny")
  })

  it("blocks RFC1918 192.168.x.x", () => {
    const rule = denyHosts(SSRF_DEFAULTS)
    expect((run(rule, "http://192.168.1.1/") as Decision)?.decision).toBe("deny")
  })

  it("blocks RFC1918 172.20.x.x via 172.16.0.0/12", () => {
    const rule = denyHosts(SSRF_DEFAULTS)
    expect((run(rule, "http://172.20.5.5/") as Decision)?.decision).toBe("deny")
  })

  it("does not block 172.32.0.0 (outside 172.16.0.0/12)", () => {
    const rule = denyHosts(SSRF_DEFAULTS)
    expect(run(rule, "http://172.32.0.0/")).toBeUndefined()
  })

  it("blocks IPv4-mapped IPv6 against IPv4 CIDR", () => {
    const rule = denyHosts(["127.0.0.0/8"])
    expect((run(rule, "https://[::ffff:127.0.0.1]/") as Decision)?.decision).toBe("deny")
  })

  it("blocks fe80::/10 link-local IPv6", () => {
    const rule = denyHosts(["fe80::/10"])
    expect((run(rule, "https://[fe80::1]/") as Decision)?.decision).toBe("deny")
  })

  it("blocks fc00::/7 ULA IPv6", () => {
    const rule = denyHosts(["fc00::/7"])
    expect((run(rule, "https://[fdab::1]/") as Decision)?.decision).toBe("deny")
  })

  it("blocks *.internal wildcard", () => {
    const rule = denyHosts(["*.internal"])
    expect((run(rule, "https://db.internal/") as Decision)?.decision).toBe("deny")
    expect(run(rule, "https://api.example.com/")).toBeUndefined()
  })

  it("blocks localhost literal", () => {
    const rule = denyHosts(["localhost"])
    expect((run(rule, "http://localhost:3000/") as Decision)?.decision).toBe("deny")
  })

  it("matches case-insensitively", () => {
    const rule = denyHosts(["Example.COM"])
    expect((run(rule, "https://EXAMPLE.com/") as Decision)?.decision).toBe("deny")
  })

  it("ignores port (host-only match)", () => {
    const rule = denyHosts(["api.example.com"])
    expect((run(rule, "https://api.example.com:9000/") as Decision)?.decision).toBe("deny")
  })

  it("allows hosts not in the list", () => {
    const rule = denyHosts(SSRF_DEFAULTS)
    expect(run(rule, "https://api.openai.com/")).toBeUndefined()
  })

  it("ignores non-http parsed actions", () => {
    const rule = denyHosts(["x.test"])
    const d = rule.evaluate({
      tool: "y",
      parsed: raw.parse({ p: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })

  it("throws on empty list at construction", () => {
    expect(() => denyHosts([])).toThrow(/empty/)
  })

  it("throws on malformed CIDR at construction", () => {
    expect(() => denyHosts(["1.2.3.4/99"])).toThrow(/invalid/)
  })

  it("throws on malformed IPv4 in CIDR at construction", () => {
    expect(() => denyHosts(["999.0.0.0/8"])).toThrow(/invalid/)
  })
})

describe("http.allowHosts", () => {
  it("denies a host that is not on the allowlist", () => {
    const rule = allowHosts(["api.openai.com"])
    const d = run(rule, "https://api.stripe.com/v1/charges") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("http.allowHosts")
  })

  it("allows a host on the allowlist", () => {
    const rule = allowHosts(["api.openai.com", "api.stripe.com"])
    expect(run(rule, "https://api.stripe.com/v1/charges")).toBeUndefined()
  })

  it("allowlist supports wildcards", () => {
    const rule = allowHosts(["*.openai.com"])
    expect(run(rule, "https://api.openai.com/")).toBeUndefined()
    expect((run(rule, "https://example.com/") as Decision)?.decision).toBe("deny")
  })

  it("ignores non-http parsed actions", () => {
    const rule = allowHosts(["x.test"])
    const d = rule.evaluate({
      tool: "y",
      parsed: raw.parse({ p: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })
})

describe("http.custom (typed helper)", () => {
  it("narrows parsed to HttpParsed and fires when predicate matches", () => {
    const rule = custom({
      on: "http.fetch",
      when: ({ parsed }) => parsed.host === "evil.test",
      decide: ({ parsed }) => deny(`blocked ${parsed.host}`, "policy.evil_host"),
    })
    const d = run(rule, "https://evil.test/x") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("skips when parsed.type is not 'http' (runtime filter)", () => {
    const rule = custom({
      when: () => true,
      decide: () => deny("would fire", "x"),
    })
    const d = rule.evaluate({
      tool: "anything",
      parsed: raw.parse({ p: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })
})

describe("SSRF_DEFAULTS", () => {
  it("is a non-empty frozen array", () => {
    expect(Array.isArray(SSRF_DEFAULTS)).toBe(true)
    expect(SSRF_DEFAULTS.length).toBeGreaterThan(0)
    expect(Object.isFrozen(SSRF_DEFAULTS)).toBe(true)
  })

  it("contains the AWS metadata IP", () => {
    expect(SSRF_DEFAULTS).toContain("169.254.169.254")
  })
})
