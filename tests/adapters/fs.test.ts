import path from "node:path"
import { describe, expect, it } from "vitest"
import { getAdapter } from "../../src/adapters"
import type { FsParsed } from "../../src/adapters/types"

const fsAdapter = getAdapter("fs")
const parse = (payload: unknown): FsParsed => fsAdapter.parse(payload) as FsParsed

const isWindows = process.platform === "win32"
const sep = isWindows ? "\\" : "/"

describe("fs adapter", () => {
  it("returns absolute path for absolute input", () => {
    const abs = isWindows ? "C:\\tmp\\x" : "/tmp/x"
    const p = parse({ path: abs })
    expect(p.type).toBe("fs")
    expect(p.absolutePath).toBe(abs)
    expect(p.operation).toBe("read")
  })

  it("resolves a relative path against cwd", () => {
    const p = parse({ path: "foo.txt" })
    expect(p.absolutePath).toBe(path.resolve("foo.txt"))
  })

  it("collapses ../ traversal during normalization", () => {
    const input = isWindows ? "C:\\a\\b\\..\\c" : "/a/b/../c"
    const expected = isWindows ? "C:\\a\\c" : "/a/c"
    const p = parse({ path: input })
    expect(p.absolutePath).toBe(expected)
  })

  it("preserves operation when explicitly provided", () => {
    const abs = isWindows ? "C:\\tmp\\x" : "/tmp/x"
    const p = parse({ path: abs, op: "delete" })
    expect(p.operation).toBe("delete")
  })

  it("defaults op to read when omitted", () => {
    const abs = isWindows ? "C:\\tmp\\x" : "/tmp/x"
    const p = parse({ path: abs })
    expect(p.operation).toBe("read")
  })

  it("rejects empty path", () => {
    expect(() => parse({ path: "" })).toThrow(/empty path/)
  })

  it("rejects payload without path", () => {
    expect(() => fsAdapter.parse({})).toThrow(/path: string/)
  })

  it("rejects path with NUL byte", () => {
    expect(() => parse({ path: "/etc/passwd\0.txt" })).toThrow(/NUL byte/)
  })

  it("rejects unknown op", () => {
    const abs = isWindows ? "C:\\tmp\\x" : "/tmp/x"
    expect(() => parse({ path: abs, op: "rename" })).toThrow(/unknown op/)
  })

  it("preserves raw payload for audit", () => {
    const p = parse({ path: "foo.txt", op: "write" })
    expect(p.raw).toEqual({ path: "foo.txt", op: "write" })
  })

  it("operates with platform separator", () => {
    const p = parse({ path: `relative${sep}sub` })
    expect(p.absolutePath.startsWith(path.resolve(""))).toBe(true)
  })
})
