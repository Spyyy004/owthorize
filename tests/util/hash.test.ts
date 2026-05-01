import { describe, expect, it } from "vitest"
import { hashPayload } from "../../src/util/hash"

describe("hashPayload", () => {
  it("is deterministic regardless of key order", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }))
  })

  it("produces different hashes for different values", () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }))
  })

  it("returns sha256-prefixed hex digest", () => {
    expect(hashPayload({ x: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("handles primitives", () => {
    expect(hashPayload("abc")).toMatch(/^sha256:/)
    expect(hashPayload(null)).toMatch(/^sha256:/)
    expect(hashPayload(undefined)).toMatch(/^sha256:/)
    expect(hashPayload(42)).toMatch(/^sha256:/)
  })

  it("handles nested arrays and objects deterministically", () => {
    const a = { xs: [1, { y: 2, z: 3 }] }
    const b = { xs: [1, { z: 3, y: 2 }] }
    expect(hashPayload(a)).toBe(hashPayload(b))
  })
})
