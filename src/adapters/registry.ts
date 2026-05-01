import type { Adapter } from "./types"

const registry = new Map<string, Adapter>()

export function registerAdapter(adapter: Adapter): void {
  registry.set(adapter.name, adapter)
}

export function getAdapter(name: string): Adapter {
  const a = registry.get(name)
  if (!a) throw new Error(`[owthorize] unknown adapter: ${name}`)
  return a
}

export function hasAdapter(name: string): boolean {
  return registry.has(name)
}

export function listAdapters(): string[] {
  return [...registry.keys()]
}
