import path from "node:path"
import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import { type Decision, deny } from "../../src/decision"
import { confineTo, custom } from "../../src/rules/fs"
import type { Rule, RuleContext } from "../../src/rules/types"

const fs = getAdapter("fs")
const raw = getAdapter("raw")

const isWindows = process.platform === "win32"
const SAFE_ROOT = isWindows ? "C:\\tmp\\agent-workspace" : "/tmp/agent-workspace"

const ctxFor = (p: string, op?: string): RuleContext => ({
  tool: "fs.write",
  parsed: fs.parse(op ? { path: p, op } : { path: p }),
  payload: { path: p },
})

const run = (rule: Rule, p: string, op?: string): Decision | void => rule.evaluate(ctxFor(p, op))

describe("fs.confineTo", () => {
  it("allows a path inside the root", () => {
    const rule = confineTo([SAFE_ROOT])
    expect(run(rule, path.join(SAFE_ROOT, "hello.txt"))).toBeUndefined()
  })

  it("allows nested paths inside the root", () => {
    const rule = confineTo([SAFE_ROOT])
    expect(run(rule, path.join(SAFE_ROOT, "deep", "nested", "file.txt"))).toBeUndefined()
  })

  it("allows the root itself", () => {
    const rule = confineTo([SAFE_ROOT])
    expect(run(rule, SAFE_ROOT)).toBeUndefined()
  })

  it("denies paths outside the root", () => {
    const rule = confineTo([SAFE_ROOT])
    const d = run(rule, isWindows ? "C:\\etc\\passwd" : "/etc/passwd") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("fs.confineTo")
  })

  it("denies sibling paths with prefix collision", () => {
    const rule = confineTo([SAFE_ROOT])
    const sibling = isWindows ? "C:\\tmp\\agent-workspace-evil\\x" : "/tmp/agent-workspace-evil/x"
    expect((run(rule, sibling) as Decision)?.decision).toBe("deny")
  })

  it("denies parent-traversal even when input contains ../", () => {
    const rule = confineTo([SAFE_ROOT])
    const traverser = isWindows
      ? "C:\\tmp\\agent-workspace\\..\\..\\etc\\passwd"
      : "/tmp/agent-workspace/../../etc/passwd"
    expect((run(rule, traverser) as Decision)?.decision).toBe("deny")
  })

  it("supports multiple roots", () => {
    const altRoot = isWindows ? "C:\\var\\data" : "/var/data"
    const rule = confineTo([SAFE_ROOT, altRoot])
    expect(run(rule, path.join(altRoot, "file.txt"))).toBeUndefined()
    expect(run(rule, path.join(SAFE_ROOT, "x"))).toBeUndefined()
  })

  it("resolves a relative root against cwd", () => {
    const rule = confineTo(["./tmp-relative-root"])
    const ok = path.resolve("./tmp-relative-root/inside")
    const bad = path.resolve("../outside")
    expect(run(rule, ok)).toBeUndefined()
    expect((run(rule, bad) as Decision)?.decision).toBe("deny")
  })

  it("respects caseInsensitive override", () => {
    const ci = confineTo([SAFE_ROOT], { caseInsensitive: true })
    const upper = SAFE_ROOT.toUpperCase()
    expect(run(ci, path.join(upper, "x"))).toBeUndefined()
  })

  it("respects case-sensitive override", () => {
    const cs = confineTo([SAFE_ROOT], { caseInsensitive: false })
    const upper = SAFE_ROOT.toUpperCase()
    if (SAFE_ROOT === upper) {
      expect(run(cs, path.join(upper, "x"))).toBeUndefined()
    } else {
      expect((run(cs, path.join(upper, "x")) as Decision)?.decision).toBe("deny")
    }
  })

  it("ignores non-fs parsed actions", () => {
    const rule = confineTo([SAFE_ROOT])
    const d = rule.evaluate({
      tool: "x",
      parsed: raw.parse({ y: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })

  it("throws on empty roots list", () => {
    expect(() => confineTo([])).toThrow(/empty/)
  })

  it("throws on invalid root entry", () => {
    expect(() => confineTo([" "])).toThrow(/invalid/)
  })

  it("flags writes outside roots as irreversible", () => {
    const rule = confineTo([SAFE_ROOT])
    const out = isWindows ? "C:\\etc\\evil.txt" : "/etc/evil.txt"
    const d = run(rule, out, "write") as Decision
    if (d?.decision === "deny") expect(d.irreversible).toBe(true)
  })

  it("flags deletes outside roots as irreversible", () => {
    const rule = confineTo([SAFE_ROOT])
    const out = isWindows ? "C:\\etc\\passwd" : "/etc/passwd"
    const d = run(rule, out, "delete") as Decision
    if (d?.decision === "deny") expect(d.irreversible).toBe(true)
  })

  it("does NOT flag reads outside roots as irreversible", () => {
    const rule = confineTo([SAFE_ROOT])
    const out = isWindows ? "C:\\etc\\passwd" : "/etc/passwd"
    const d = run(rule, out, "read") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.irreversible).toBeUndefined()
  })
})

describe("fs.custom (typed helper)", () => {
  it("narrows parsed to FsParsed and fires when predicate matches", () => {
    const rule = custom({
      on: "fs.write",
      when: ({ parsed }) => parsed.operation === "delete",
      decide: ({ parsed }) => deny(`delete on ${parsed.absolutePath} blocked`, "policy.no_delete"),
    })
    const d = run(rule, "/tmp/x", "delete") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("skips when parsed.type is not 'fs' (runtime filter)", () => {
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
