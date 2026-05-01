import { registerAdapter } from "./registry"
import type { Adapter, RawParsed } from "./types"

const rawAdapter: Adapter = {
  name: "raw",
  parse(payload): RawParsed {
    return { type: "raw", payload }
  },
}

registerAdapter(rawAdapter)
