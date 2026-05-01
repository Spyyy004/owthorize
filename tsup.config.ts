import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    openai: "src/shims/openai.ts",
    anthropic: "src/shims/anthropic.ts",
    langchain: "src/shims/langchain.ts",
    "vercel-ai": "src/shims/vercel-ai.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
})
