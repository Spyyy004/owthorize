import { describe, expect, it } from "vitest"
import { REDACTED, redactPaths } from "../../src/util/redact"

describe("redactPaths", () => {
  it("redacts a top-level key", () => {
    expect(redactPaths({ a: 1, b: 2 }, ["a"])).toEqual({ a: REDACTED, b: 2 })
  })

  it("redacts a nested key", () => {
    expect(redactPaths({ user: { password: "x", name: "n" } }, ["user.password"])).toEqual({
      user: { password: REDACTED, name: "n" },
    })
  })

  it("does not mutate the input", () => {
    const input = { a: { b: 1 } }
    redactPaths(input, ["a.b"])
    expect(input.a.b).toBe(1)
  })

  it("missing path is a no-op", () => {
    expect(redactPaths({ a: 1 }, ["b.c"])).toEqual({ a: 1 })
  })

  it("supports * wildcard over arrays", () => {
    expect(redactPaths({ tokens: ["a", "b", "c"] }, ["tokens.*"])).toEqual({
      tokens: [REDACTED, REDACTED, REDACTED],
    })
  })

  it("supports * wildcard over objects", () => {
    expect(redactPaths({ headers: { a: "1", b: "2" } }, ["headers.*"])).toEqual({
      headers: { a: REDACTED, b: REDACTED },
    })
  })

  it("supports numeric index into arrays", () => {
    expect(redactPaths({ xs: ["a", "b", "c"] }, ["xs.1"])).toEqual({
      xs: ["a", REDACTED, "c"],
    })
  })

  it("returns primitives unchanged", () => {
    expect(redactPaths(42, ["x"])).toBe(42)
    expect(redactPaths(null, ["x"])).toBe(null)
    expect(redactPaths("hello", ["x"])).toBe("hello")
  })

  it("handles deep paths with arrays in the middle", () => {
    expect(redactPaths({ a: [{ b: 1 }, { b: 2 }] }, ["a.*.b"])).toEqual({
      a: [{ b: REDACTED }, { b: REDACTED }],
    })
  })
})
