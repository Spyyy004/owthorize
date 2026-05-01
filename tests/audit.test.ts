import { describe, expect, it, vi } from "vitest"
import { Audit, silentSink } from "../src/audit"
import { ALLOW, deny } from "../src/decision"

describe("Audit", () => {
  it("writes a record with hashed payload for allow", () => {
    const sink = vi.fn()
    new Audit({ sink }).write({
      tool: "db.query",
      adapter: "sql.postgres",
      parsed: null,
      payload: { query: "SELECT 1" },
      decision: ALLOW,
    })
    expect(sink).toHaveBeenCalledOnce()
    const r = sink.mock.calls[0]?.[0]
    expect(r.tool).toBe("db.query")
    expect(r.decision).toBe("allow")
    expect(r.payload_hash).toMatch(/^sha256:/)
    expect(r.simulated).toBe(false)
    expect(r.matched_rule).toBe(null)
  })

  it("captures deny reason, matched rule, and rule kind", () => {
    const sink = vi.fn()
    new Audit({ sink }).write({
      tool: "db.query",
      adapter: "sql.postgres",
      parsed: null,
      payload: { query: "DROP TABLE x" },
      decision: deny("DDL not allowed", "sql.denyDDL"),
    })
    const r = sink.mock.calls[0]?.[0]
    expect(r.decision).toBe("deny")
    expect(r.reason).toBe("DDL not allowed")
    expect(r.matched_rule).toBe("sql.denyDDL")
    expect(r.matched_rule_kind).toBe("builtin")
  })

  it("uses custom-local rule kind when specified", () => {
    const sink = vi.fn()
    new Audit({ sink }).write({
      tool: "db.query",
      adapter: null,
      parsed: null,
      payload: {},
      decision: deny("custom rule", "myrule"),
      ruleKind: "custom-local",
    })
    expect(sink.mock.calls[0]?.[0].matched_rule_kind).toBe("custom-local")
  })

  it("redacts before hashing so the hash is invariant under redacted-field changes", () => {
    const sink = vi.fn()
    const a = new Audit({ sink })
    a.write({
      tool: "db.query",
      adapter: null,
      parsed: null,
      payload: { params: { password: "secret-1" } },
      redact: ["params.password"],
      decision: ALLOW,
    })
    a.write({
      tool: "db.query",
      adapter: null,
      parsed: null,
      payload: { params: { password: "secret-2" } },
      redact: ["params.password"],
      decision: ALLOW,
    })
    expect(sink.mock.calls[0]?.[0].payload_hash).toBe(sink.mock.calls[1]?.[0].payload_hash)
  })

  it("falls back to fallbackSink when sink throws synchronously", () => {
    const sink = vi.fn(() => {
      throw new Error("boom")
    })
    const fallback = vi.fn()
    new Audit({ sink, fallbackSink: fallback }).write({
      tool: "x",
      adapter: null,
      parsed: null,
      payload: {},
      decision: deny("nope", "r1"),
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it("rethrows on sync sink failure when onLogError=throw", () => {
    const sink = vi.fn(() => {
      throw new Error("boom")
    })
    const audit = new Audit({ sink, onLogError: "throw" })
    expect(() =>
      audit.write({
        tool: "x",
        adapter: null,
        parsed: null,
        payload: {},
        decision: ALLOW,
      }),
    ).toThrow("boom")
  })

  it("falls back when async sink rejects", async () => {
    const sink = vi.fn(() => Promise.reject(new Error("async boom")))
    const fallback = vi.fn()
    new Audit({ sink, fallbackSink: fallback }).write({
      tool: "x",
      adapter: null,
      parsed: null,
      payload: {},
      decision: ALLOW,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(fallback).toHaveBeenCalledOnce()
  })

  it("never throws if both sinks fail", () => {
    const sink = vi.fn(() => {
      throw new Error("a")
    })
    const fallback = vi.fn(() => {
      throw new Error("b")
    })
    expect(() =>
      new Audit({ sink, fallbackSink: fallback }).write({
        tool: "x",
        adapter: null,
        parsed: null,
        payload: {},
        decision: ALLOW,
      }),
    ).not.toThrow()
  })

  it("silentSink is callable, returns void, and emits nothing", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    new Audit({ sink: silentSink }).write({
      tool: "x",
      adapter: null,
      parsed: null,
      payload: { secret: 1 },
      decision: ALLOW,
    })
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
    expect(silentSink({} as never)).toBeUndefined()
  })
})
