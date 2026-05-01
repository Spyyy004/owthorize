import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import type { HttpParsed } from "../../src/adapters/types"

const http = getAdapter("http")
const parse = (payload: unknown): HttpParsed => http.parse(payload) as HttpParsed

describe("http adapter", () => {
  it("parses an absolute https URL", () => {
    const p = parse({ url: "https://api.example.com/v1/users?limit=10" })
    expect(p.type).toBe("http")
    expect(p.method).toBe("GET")
    expect(p.host).toBe("api.example.com")
    expect(p.hostNormalized).toBe("api.example.com")
    expect(p.port).toBeNull()
    expect(p.path).toBe("/v1/users")
    expect(p.query).toEqual({ limit: "10" })
  })

  it("uppercases method", () => {
    const p = parse({ url: "https://x.test/", method: "post" })
    expect(p.method).toBe("POST")
  })

  it("defaults method to GET when omitted", () => {
    const p = parse({ url: "https://x.test/" })
    expect(p.method).toBe("GET")
  })

  it("returns null port for default scheme port", () => {
    const p = parse({ url: "https://x.test/" })
    expect(p.port).toBeNull()
  })

  it("preserves explicit non-default port", () => {
    const p = parse({ url: "http://x.test:8080/" })
    expect(p.port).toBe(8080)
  })

  it("rejects relative URLs", () => {
    expect(() => parse({ url: "/foo/bar" })).toThrow(/invalid url/)
  })

  it("rejects empty URL", () => {
    expect(() => parse({ url: "   " })).toThrow(/empty url/)
  })

  it("rejects file:// scheme", () => {
    expect(() => parse({ url: "file:///etc/passwd" })).toThrow(/unsupported scheme/)
  })

  it("rejects javascript: scheme", () => {
    expect(() => parse({ url: "javascript:alert(1)" })).toThrow(/unsupported scheme/)
  })

  it("rejects payload missing url", () => {
    expect(() => http.parse({})).toThrow(/url: string/)
  })

  it("punycodes IDN host", () => {
    const p = parse({ url: "https://例え.テスト/path" })
    expect(p.host).toBe("xn--r8jz45g.xn--zckzah")
    expect(p.hostNormalized).toBe("xn--r8jz45g.xn--zckzah")
  })

  it("strips userinfo from rebuilt url", () => {
    const p = parse({ url: "https://alice:secret@example.com/x" })
    expect(p.url).not.toContain("alice")
    expect(p.url).not.toContain("secret")
    expect(p.host).toBe("example.com")
  })

  it("strips IPv6 brackets in hostNormalized", () => {
    const p = parse({ url: "https://[::1]:8443/" })
    expect(p.host).toBe("[::1]")
    expect(p.hostNormalized).toBe("::1")
    expect(p.port).toBe(8443)
  })

  it("strips trailing dot from FQDN in hostNormalized", () => {
    const p = parse({ url: "https://example.com./" })
    expect(p.hostNormalized).toBe("example.com")
  })

  it("computes bodySize from string", () => {
    const p = parse({ url: "https://x.test/", body: "hello" })
    expect(p.bodySize).toBe(5)
  })

  it("computes bodySize from Buffer", () => {
    const p = parse({ url: "https://x.test/", body: Buffer.from("héllo") })
    expect(p.bodySize).toBe(Buffer.byteLength("héllo", "utf8"))
  })

  it("computes bodySize from Uint8Array", () => {
    const p = parse({ url: "https://x.test/", body: new Uint8Array([1, 2, 3, 4]) })
    expect(p.bodySize).toBe(4)
  })

  it("computes bodySize from object (JSON)", () => {
    const p = parse({ url: "https://x.test/", body: { a: 1 } })
    expect(p.bodySize).toBe(Buffer.byteLength('{"a":1}', "utf8"))
  })

  it("returns bodySize 0 when body absent", () => {
    const p = parse({ url: "https://x.test/" })
    expect(p.bodySize).toBe(0)
  })

  it("collects header keys lowercased and sorted", () => {
    const p = parse({
      url: "https://x.test/",
      headers: { "Content-Type": "application/json", AUTHORIZATION: "Bearer x" },
    })
    expect(p.headerKeys).toEqual(["authorization", "content-type"])
  })

  it("collects header keys from Headers instance", () => {
    const headers = new Headers({ "X-Foo": "1", "X-Bar": "2" })
    const p = parse({ url: "https://x.test/", headers })
    expect(p.headerKeys.sort()).toEqual(["x-bar", "x-foo"])
  })

  it("collects header keys from array of pairs", () => {
    const p = parse({
      url: "https://x.test/",
      headers: [
        ["X-One", "a"],
        ["X-Two", "b"],
      ],
    })
    expect(p.headerKeys).toEqual(["x-one", "x-two"])
  })

  it("collects multi-valued query params as array", () => {
    const p = parse({ url: "https://x.test/?tag=a&tag=b" })
    expect(p.query.tag).toEqual(["a", "b"])
  })

  it("defaults pathname to / when missing", () => {
    const p = parse({ url: "https://x.test" })
    expect(p.path).toBe("/")
  })
})
