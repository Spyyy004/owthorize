import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import type { ShellParsed } from "../../src/adapters/types"

const shell = getAdapter("shell")
const parse = (payload: unknown): ShellParsed => shell.parse(payload) as ShellParsed

describe("shell adapter", () => {
  it("tokenizes a simple command into argv", () => {
    const p = parse({ command: "ls -la /tmp" })
    expect(p.type).toBe("shell")
    expect(p.command).toBe("ls")
    expect(p.argv).toEqual(["ls", "-la", "/tmp"])
    expect(p.hasMetachar).toBe(false)
  })

  it("detects pipe metachar", () => {
    const p = parse({ command: "ls | grep foo" })
    expect(p.hasPipe).toBe(true)
    expect(p.hasMetachar).toBe(true)
    expect(p.command).toBe("ls")
  })

  it("detects redirect metachar", () => {
    const p = parse({ command: "echo hi > out.txt" })
    expect(p.hasRedirect).toBe(true)
    expect(p.hasMetachar).toBe(true)
  })

  it("detects && operator as metachar", () => {
    const p = parse({ command: "make && make install" })
    expect(p.hasMetachar).toBe(true)
    expect(p.hasPipe).toBe(false)
    expect(p.hasRedirect).toBe(false)
  })

  it("detects backtick substitution", () => {
    const p = parse({ command: "echo `whoami`" })
    expect(p.hasSubstitution).toBe(true)
    expect(p.hasMetachar).toBe(true)
  })

  it("detects $() substitution", () => {
    const p = parse({ command: "echo $(date)" })
    expect(p.hasSubstitution).toBe(true)
    expect(p.hasMetachar).toBe(true)
  })

  it("does not flag metachars inside double quotes", () => {
    const p = parse({ command: 'echo "a;b|c"' })
    expect(p.argv).toEqual(["echo", "a;b|c"])
    expect(p.hasPipe).toBe(false)
    expect(p.hasMetachar).toBe(false)
  })

  it("does not flag metachars inside single quotes", () => {
    const p = parse({ command: "echo 'rm -rf /'" })
    expect(p.argv).toEqual(["echo", "rm -rf /"])
    expect(p.hasMetachar).toBe(false)
  })

  it("strips leading env-var assignments to find the command", () => {
    const p = parse({ command: "FOO=bar BAZ=qux node app.js" })
    expect(p.command).toBe("node")
  })

  it("extracts command from full path", () => {
    const p = parse({ command: "/usr/bin/rm -rf /tmp/x" })
    expect(p.command).toBe("/usr/bin/rm")
  })

  it("rejects empty command string", () => {
    expect(() => parse({ command: "   " })).toThrow(/empty command/)
  })

  it("rejects payload without command or argv", () => {
    expect(() => shell.parse({})).toThrow(/command|argv/)
  })

  it("accepts argv input", () => {
    const p = parse({ argv: ["rm", "-rf", "/tmp"] })
    expect(p.command).toBe("rm")
    expect(p.argv).toEqual(["rm", "-rf", "/tmp"])
    expect(p.hasMetachar).toBe(false)
  })

  it("rejects empty argv", () => {
    expect(() => parse({ argv: [] })).toThrow(/empty argv/)
  })

  it("rejects argv with empty first element", () => {
    expect(() => parse({ argv: [""] })).toThrow(/empty argv/)
  })

  it("preserves raw input for audit", () => {
    const p = parse({ command: "ls -la" })
    expect(p.raw).toBe("ls -la")
  })
})
