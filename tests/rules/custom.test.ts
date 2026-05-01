import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import { type Decision, deny } from "../../src/decision"
import { custom } from "../../src/rules/custom"
import type { RuleContext } from "../../src/rules/types"

const raw = getAdapter("raw")

const baseCtx = (tool = "db.query", payload: unknown = { x: 1 }): RuleContext => ({
  tool,
  parsed: raw.parse(payload),
  payload,
})

describe("rules.custom", () => {
  it("fires when predicate is truthy", () => {
    const rule = custom({
      on: "db.query",
      when: () => true,
      decide: () => deny("blocked by custom rule", "custom.test"),
    })
    const d = rule.evaluate(baseCtx()) as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("custom.test")
  })

  it("does not fire when predicate is falsy", () => {
    const rule = custom({
      on: "db.query",
      when: () => false,
      decide: () => deny("won't fire", "x"),
    })
    expect(rule.evaluate(baseCtx())).toBeUndefined()
  })

  it("kind is custom-local", () => {
    const rule = custom({ on: "x", when: () => false, decide: () => undefined })
    expect(rule.kind).toBe("custom-local")
  })

  it("auto-generates a stable name when not provided", () => {
    const w = () => true
    const d = () => deny("x", "y")
    const a = custom({ on: "t", when: w, decide: d })
    const b = custom({ on: "t", when: w, decide: d })
    expect(a.name).toBe(b.name)
    expect(a.name).toMatch(/^custom-local:/)
  })

  it("uses provided name when supplied", () => {
    const rule = custom({
      name: "my.rule",
      on: "x",
      when: () => true,
      decide: () => deny("r", "my.rule"),
    })
    expect(rule.name).toBe("my.rule")
  })

  it("falls back to rule name when decide omits matched", () => {
    const rule = custom({
      name: "my.rule",
      on: "x",
      when: () => true,
      decide: () => ({ decision: "deny", reason: "r" }) as Decision,
    })
    const d = rule.evaluate(baseCtx()) as Decision
    if (d?.decision === "deny") expect(d.matched).toBe("my.rule")
  })

  it("treats decide returning {decision:'allow'} as no-op", () => {
    const rule = custom({
      on: "x",
      when: () => true,
      decide: () => ({ decision: "allow" }) as Decision,
    })
    expect(rule.evaluate(baseCtx())).toBeUndefined()
  })

  it("throws when when() returns a Promise", () => {
    const rule = custom({
      on: "x",
      when: () => Promise.resolve(true) as unknown as boolean,
      decide: () => deny("x", "y"),
    })
    expect(() => rule.evaluate(baseCtx())).toThrow(/synchronous/)
  })

  it("throws when decide() returns a Promise", () => {
    const rule = custom({
      on: "x",
      when: () => true,
      decide: () => Promise.resolve(deny("x", "y")) as unknown as Decision,
    })
    expect(() => rule.evaluate(baseCtx())).toThrow(/synchronous/)
  })

  it("throws when decide returns invalid shape", () => {
    const rule = custom({
      on: "x",
      when: () => true,
      decide: () => ({ what: "ever" }) as unknown as Decision,
    })
    expect(() => rule.evaluate(baseCtx())).toThrow(/invalid Decision shape/)
  })

  it("scopes via `on` field (carried by Guard, kept by rule)", () => {
    const rule = custom({ on: ["db.query", "db.exec"], when: () => true, decide: () => undefined })
    expect(rule.on).toEqual(["db.query", "db.exec"])
  })

  it("throws when spec is missing when/decide", () => {
    expect(() => custom({} as never)).toThrow(/when.*decide/)
  })

  it("predicate truthy non-boolean accepted", () => {
    const rule = custom({
      on: "x",
      when: () => 1 as unknown as boolean,
      decide: () => deny("yes", "y"),
    })
    expect((rule.evaluate(baseCtx()) as Decision)?.decision).toBe("deny")
  })
})
