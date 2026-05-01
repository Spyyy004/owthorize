import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import { type Decision, deny } from "../../src/decision"
import { custom, denyCommands } from "../../src/rules/shell"
import type { Rule, RuleContext } from "../../src/rules/types"

const shell = getAdapter("shell")
const raw = getAdapter("raw")

const ctxFor = (command: string): RuleContext => ({
  tool: "shell.exec",
  parsed: shell.parse({ command }),
  payload: { command },
})

const ctxArgv = (argv: string[]): RuleContext => ({
  tool: "shell.exec",
  parsed: shell.parse({ argv }),
  payload: { argv },
})

const run = (rule: Rule, command: string): Decision | void => rule.evaluate(ctxFor(command))

describe("shell.denyCommands", () => {
  it("denies a command by basename", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "rm -rf /tmp/x") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("shell.denyCommands")
  })

  it("denies a command via full path", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "/usr/bin/rm /tmp/x") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("strips .exe and matches on basename (Windows-style)", () => {
    const rule = denyCommands(["rm"])
    const d = rule.evaluate(ctxArgv(["C:\\bin\\rm.exe", "/tmp/x"])) as Decision
    expect(d?.decision).toBe("deny")
  })

  it("matches case-insensitively by default", () => {
    const rule = denyCommands(["RM"])
    expect((run(rule, "rm /tmp/x") as Decision)?.decision).toBe("deny")
  })

  it("respects caseSensitive option", () => {
    const rule = denyCommands(["RM"], { caseSensitive: true })
    expect(run(rule, "rm /tmp/x")).toBeUndefined()
  })

  it("allows a safe command", () => {
    const rule = denyCommands(["rm", "curl", "wget"])
    expect(run(rule, "ls -la /tmp")).toBeUndefined()
  })

  it("denies on pipe (metachar) before basename check", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "ls | grep foo") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("shell.metachar")
  })

  it("denies on redirect", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "echo hi > /tmp/out") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("shell.metachar")
  })

  it("denies on backtick substitution", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "echo `whoami`") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("shell.metachar")
  })

  it("denies on $() substitution", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "echo $(date)") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.matched).toBe("shell.metachar")
  })

  it("denies on && operator (other metachar)", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "make && echo done") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("does not flag metachar inside quotes", () => {
    const rule = denyCommands(["rm"])
    expect(run(rule, 'echo "a;b"')).toBeUndefined()
  })

  it("respects allowMetachar option", () => {
    const rule = denyCommands(["rm"], { allowMetachar: true })
    expect(run(rule, "ls | grep foo")).toBeUndefined()
  })

  it("with allowMetachar still denies basename match", () => {
    const rule = denyCommands(["rm"], { allowMetachar: true })
    expect((run(rule, "rm /tmp/x") as Decision)?.decision).toBe("deny")
  })

  it("ignores non-shell parsed actions", () => {
    const rule = denyCommands(["rm"])
    const d = rule.evaluate({
      tool: "x",
      parsed: raw.parse({ y: 1 }),
      payload: {},
    })
    expect(d).toBeUndefined()
  })

  it("throws on empty command list", () => {
    expect(() => denyCommands([])).toThrow(/empty/)
  })

  it("throws on invalid command entry", () => {
    expect(() => denyCommands([" "])).toThrow(/invalid/)
  })

  it("flags rm (in DESTRUCTIVE_DEFAULTS) as irreversible", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "rm -rf /tmp/x") as Decision
    if (d?.decision === "deny") expect(d.irreversible).toBe(true)
  })

  it("does NOT flag curl (network read) as irreversible by default", () => {
    const rule = denyCommands(["curl"])
    const d = run(rule, "curl http://example.com") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.irreversible).toBeUndefined()
  })

  it("does NOT flag wget as irreversible by default", () => {
    const rule = denyCommands(["wget"])
    const d = run(rule, "wget http://example.com") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.irreversible).toBeUndefined()
  })

  it("flags dd (in DESTRUCTIVE_DEFAULTS) as irreversible", () => {
    const rule = denyCommands(["dd"])
    const d = run(rule, "dd if=/dev/zero of=/dev/sda") as Decision
    if (d?.decision === "deny") expect(d.irreversible).toBe(true)
  })

  it("respects an empty `destructive` override (nothing is irreversible)", () => {
    const rule = denyCommands(["rm"], { destructive: [] })
    const d = run(rule, "rm -rf /") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.irreversible).toBeUndefined()
  })

  it("respects a custom `destructive` override", () => {
    const rule = denyCommands(["rm", "curl", "ssh"], { destructive: ["ssh"] })
    const dRm = run(rule, "rm -rf /tmp/x") as Decision
    if (dRm?.decision === "deny") expect(dRm.irreversible).toBeUndefined()
    const dCurl = run(rule, "curl http://x.test") as Decision
    if (dCurl?.decision === "deny") expect(dCurl.irreversible).toBeUndefined()
    const dSsh = run(rule, "ssh user@host") as Decision
    if (dSsh?.decision === "deny") expect(dSsh.irreversible).toBe(true)
  })

  it("does NOT flag metachar-only denies as irreversible", () => {
    const rule = denyCommands(["rm"])
    const d = run(rule, "ls | grep foo") as Decision
    expect(d?.decision).toBe("deny")
    if (d?.decision === "deny") expect(d.irreversible).toBeUndefined()
  })
})

describe("shell.custom (typed helper)", () => {
  it("narrows parsed to ShellParsed and fires when predicate matches", () => {
    const rule = custom({
      on: "shell.exec",
      when: ({ parsed }) => parsed.command === "rm",
      decide: ({ parsed }) => deny(`blocked ${parsed.command}`, "policy.no_rm"),
    })
    const d = run(rule, "rm -rf /tmp/x") as Decision
    expect(d?.decision).toBe("deny")
  })

  it("skips when parsed.type is not 'shell' (runtime filter)", () => {
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
