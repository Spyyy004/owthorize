import { describe, expect, it, vi } from "vitest"
import { GuardDenied, deny } from "../src/decision"
import { Guard } from "../src/guard"
import type { Rule } from "../src/rules/types"

const silent = { sink: () => {} }

const denyAll: Rule = {
  name: "denyAll",
  evaluate: () => deny("blocked", "denyAll"),
}

describe("Guard", () => {
  it("registers and runs an allowed tool", async () => {
    const guard = new Guard({ audit: silent })
    const fn = guard.tool("echo", {
      handler: async (input: { msg: string }) => input.msg.toUpperCase(),
    })
    expect(await fn({ msg: "hi" })).toBe("HI")
  })

  it("throws GuardDenied with structured fields when denied", async () => {
    const guard = new Guard({ rules: [denyAll], audit: silent })
    const fn = guard.tool("x", { handler: () => "ok" })
    try {
      await fn(null)
      expect.fail("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(GuardDenied)
      const e = err as GuardDenied
      expect(e.tool).toBe("x")
      expect(e.reason).toBe("blocked")
      expect(e.matched).toBe("denyAll")
    }
  })

  it("does not call handler when denied", async () => {
    const handler = vi.fn(() => "ok")
    const guard = new Guard({ rules: [denyAll], audit: silent })
    const fn = guard.tool("x", { handler })
    await expect(fn(null)).rejects.toBeInstanceOf(GuardDenied)
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects duplicate tool registration", () => {
    const guard = new Guard({ audit: silent })
    guard.tool("x", { handler: () => "a" })
    expect(() => guard.tool("x", { handler: () => "b" })).toThrow(/already registered/)
  })

  it("check() returns Decision without executing handler", async () => {
    const handler = vi.fn(() => "ok")
    const guard = new Guard({ rules: [denyAll], audit: silent })
    guard.tool("x", { handler })
    const d = await guard.check({ tool: "x", payload: null })
    expect(d.decision).toBe("deny")
    expect(handler).not.toHaveBeenCalled()
  })

  it("simulate() returns Decision and writes audit with simulated=true", () => {
    const sink = vi.fn()
    const guard = new Guard({ rules: [denyAll], audit: { sink } })
    guard.tool("x", { handler: () => "ok" })
    const d = guard.simulate("x", null)
    expect(d.decision).toBe("deny")
    expect(sink).toHaveBeenCalledOnce()
    expect(sink.mock.calls[0]?.[0].simulated).toBe(true)
  })

  it("denies unknown tool by default", async () => {
    const guard = new Guard({ audit: silent })
    const d = await guard.check({ tool: "missing", payload: null })
    expect(d.decision).toBe("deny")
    if (d.decision === "deny") {
      expect(d.matched).toBe("owthorize.unknownTool")
    }
  })

  it("allows unknown tool when policy=allow", async () => {
    const guard = new Guard({
      audit: silent,
      defaults: { onUnknownTool: "allow" },
    })
    const d = await guard.check({ tool: "missing", payload: null })
    expect(d.decision).toBe("allow")
  })

  it("denies on rule throw by default", async () => {
    const broken: Rule = {
      name: "broken",
      evaluate: () => {
        throw new Error("boom")
      },
    }
    const guard = new Guard({ rules: [broken], audit: silent })
    const fn = guard.tool("x", { handler: () => "ok" })
    try {
      await fn(null)
      expect.fail("should have thrown")
    } catch (err) {
      const e = err as GuardDenied
      expect(e).toBeInstanceOf(GuardDenied)
      expect(e.matched).toBe("owthorize.ruleError:broken")
    }
  })

  it("allows on rule throw when policy=allow", async () => {
    const broken: Rule = {
      name: "broken",
      evaluate: () => {
        throw new Error("boom")
      },
    }
    const guard = new Guard({
      rules: [broken],
      audit: silent,
      defaults: { onRuleError: "allow" },
    })
    const fn = guard.tool("x", { handler: () => "ok" })
    expect(await fn(null)).toBe("ok")
  })

  it("respects rule.on filter (string)", async () => {
    const aOnly: Rule = {
      name: "a-only",
      on: "a",
      evaluate: () => deny("a only", "a-only"),
    }
    const guard = new Guard({ rules: [aOnly], audit: silent })
    const a = guard.tool("a", { handler: () => "ok" })
    const b = guard.tool("b", { handler: () => "ok" })
    await expect(a(null)).rejects.toBeInstanceOf(GuardDenied)
    expect(await b(null)).toBe("ok")
  })

  it("respects rule.on filter (array)", async () => {
    const some: Rule = {
      name: "some",
      on: ["a", "c"],
      evaluate: () => deny("blocked", "some"),
    }
    const guard = new Guard({ rules: [some], audit: silent })
    const a = guard.tool("a", { handler: () => "ok" })
    const b = guard.tool("b", { handler: () => "ok" })
    await expect(a(null)).rejects.toBeInstanceOf(GuardDenied)
    expect(await b(null)).toBe("ok")
  })

  it("first deny wins; subsequent rules are not consulted", async () => {
    const calls: string[] = []
    const r1: Rule = {
      name: "r1",
      evaluate: () => {
        calls.push("r1")
        return deny("first", "r1")
      },
    }
    const r2: Rule = {
      name: "r2",
      evaluate: () => {
        calls.push("r2")
      },
    }
    const guard = new Guard({ rules: [r1, r2], audit: silent })
    const fn = guard.tool("x", { handler: () => "ok" })
    await expect(fn(null)).rejects.toBeInstanceOf(GuardDenied)
    expect(calls).toEqual(["r1"])
  })

  it("uses raw adapter by default and parses payload through it", async () => {
    const sink = vi.fn()
    const guard = new Guard({ audit: { sink } })
    const fn = guard.tool("x", { handler: () => "ok" })
    await fn({ msg: "hi" })
    const r = sink.mock.calls[0]?.[0]
    expect(r.adapter).toBe("raw")
    expect(r.parsed).toEqual({ type: "raw", payload: { msg: "hi" } })
  })

  it("denies on adapter error by default", async () => {
    const sink = vi.fn()
    const guard = new Guard({ audit: { sink } })
    const fn = guard.tool("x", {
      adapter: "does-not-exist",
      handler: () => "ok",
    })
    await expect(fn(null)).rejects.toBeInstanceOf(GuardDenied)
    expect(sink.mock.calls[0]?.[0].matched_rule).toBe("owthorize.adapterError")
  })
})
