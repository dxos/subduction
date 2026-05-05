import { describe, test, expect, beforeAll } from "vitest"

// Tests use the BUILT package via its Node entry. Importing here triggers
// auto-init at module-load time (the `node.js` wrapper synchronously calls
// `initSync` and `setWasmApi`). All later tests rely on this side-effect.
import {
  init,
  change,
  isWasmInitialized,
  isWasmLoaded,
  initializeWasm,
  reinitWasmSync,
} from "../dist/esm/node.js"

describe("init / isWasmInitialized / isWasmLoaded / reinitWasmSync", () => {
  test("after auto-init from `node.js` import, both flags are true", () => {
    expect(isWasmInitialized()).toBe(true)
    expect(isWasmLoaded()).toBe(true)
  })

  test("calling initializeWasm with the same wasm bytes does not throw", async () => {
    // Read our own wasm and re-init. The wasm-bindgen layer's __wbg_init
    // re-entry guard was patched away so this resolves rather than no-ops.
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const { dirname, join } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))
    const wasmPath = join(here, "..", "dist", "automerge-subduction.wasm")
    const bytes = readFileSync(wasmPath)
    const instance = await initializeWasm(bytes)
    expect(instance).toBeDefined()
    expect(isWasmInitialized()).toBe(true)
    expect(isWasmLoaded()).toBe(true)
  })

  test("reinitWasmSync resets wasm linear memory and keeps isWasmLoaded true", () => {
    expect(isWasmLoaded()).toBe(true)
    reinitWasmSync()
    expect(isWasmLoaded()).toBe(true)
    // After reset, brand-new docs still work.
    const doc = change(init<{ k: number }>(), (d) => {
      d.k = 42
    })
    expect(doc.k).toBe(42)
  })
})
