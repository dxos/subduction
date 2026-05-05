import { describe, test, expect } from "vitest"
import { existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, "..", "dist")

describe("dist/ layout", () => {
  test("exactly one production .wasm at top level (no debug variants)", () => {
    const top = readdirSync(DIST)
    const wasms = top.filter((f) => f.endsWith(".wasm"))
    expect(wasms).toEqual(["automerge-subduction.wasm"])
    expect(top.some((f) => f.endsWith("-debug.wasm"))).toBe(false)
  })

  test("ESM wrappers exist for every shipped target", () => {
    for (const f of [
      "esm/node.js",
      "esm/web.js",
      "esm/workerd.js",
      "esm/bundler.js",
      "esm/slim.js",
      "esm/wasm-base64.js",
    ]) {
      expect(existsSync(join(DIST, f))).toBe(true)
    }
  })

  test("CJS wrappers exist", () => {
    for (const f of ["cjs/node.cjs", "cjs/web.cjs", "cjs/slim.cjs", "cjs/wasm-base64.cjs"]) {
      expect(existsSync(join(DIST, f))).toBe(true)
    }
  })

  test("IIFE bundle exists", () => {
    expect(existsSync(join(DIST, "iife/index.js"))).toBe(true)
  })

  test("wasm_bindgen targets exist", () => {
    for (const t of ["nodejs", "web", "bundler"]) {
      const f = join(DIST, "wasm_bindgen", t)
      expect(existsSync(f)).toBe(true)
      // No *-debug subdirectories.
      expect(t.endsWith("-debug")).toBe(false)
    }
  })

  test("vendored Automerge layer compiled to dist/automerge", () => {
    const required = [
      "implementation.js",
      "implementation.d.ts",
      "implementation.cjs",
      "low_level.js",
      "low_level.cjs",
      "low_level.d.ts",
      "proxies.js",
      "apply_patches.js",
    ]
    for (const f of required) {
      expect(existsSync(join(DIST, "automerge", f))).toBe(true)
    }
  })

  test("dist/index.d.ts exists", () => {
    expect(existsSync(join(DIST, "index.d.ts"))).toBe(true)
  })

  test("no debug paths anywhere under dist/", () => {
    function walk(dir: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          out.push(...walk(path))
        } else {
          out.push(path)
        }
      }
      return out
    }
    const all = walk(DIST)
    const debugFiles = all.filter((p) =>
      /\/debug-|-debug\.|\/iife\/debug\./.test(p),
    )
    expect(debugFiles).toEqual([])
  })
})
