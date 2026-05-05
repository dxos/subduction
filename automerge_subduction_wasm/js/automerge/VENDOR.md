# Vendored `@automerge/automerge` JS layer

Source: [`automerge/automerge` repository](https://github.com/automerge/automerge), tag
[`rust/automerge-0.8.0`](https://github.com/automerge/automerge/releases/tag/rust/automerge-0.8.0),
commit `8246d0f8218cd49dc1af56ba6eefd88ed215665c`. Same rev as the vendored Rust crate at
`crates/automerge_wasm/`.

Imported on **2026-05-05**.

At this commit, `javascript/package.json` declares `version = "3.2.5"` (the npm `@automerge/automerge` 3.x line).

## Files

Copied verbatim from upstream `javascript/src/`:

- `apply_patches.ts`
- `conflicts.ts`
- `constants.ts`
- `counter.ts`
- `immutable_string.ts`
- `implementation.ts`
- `internal_state.ts`
- `numbers.ts`
- `proxies.ts`
- `types.ts`

Locally modified:

- `low_level.ts` — Replaced upstream's hard-coded
  `import { default as initWasm } from "./wasm_bindgen_output/web/automerge_wasm.js"` and
  `import * as WasmApi from "./wasm_bindgen_output/web/automerge_wasm.js"` with a
  parameter-injected `setWasmApi(api)` function. Per-target wrappers in
  `automerge_subduction_wasm/js/src/` call this with the bodge-produced wasm-bindgen module
  (`dist/wasm_bindgen/web/automerge_subduction_wasm.js`). Also added top-level
  `isWasmLoaded` and `reinitWasmSync` exports that forward to the wasm-bindgen layer's
  patched additions (see workstream 5b in the implementation plan); changed
  `initializeWasm` to resolve with the WebAssembly instance instead of `void`.

Generated at build time:

- `wasm_types.d.ts` — Stub committed; replaced by `build_js.js` with the real type
  declarations copied from `dist/wasm_bindgen/nodejs/automerge_subduction_wasm.d.ts`.

Not vendored:

- `index.ts` — Upstream re-exports `* from implementation` and `* as next from implementation`
  here. We expose a different surface from `automerge_subduction_wasm/js/src/index.ts`
  (spec-listed top-level + `next` namespace + Subduction surface).
- `entrypoints/` — Per-target wrappers; replaced by our own under `js/src/`.

## Re-vendoring procedure

If we refresh against a newer upstream:

1. Pick a target tag/commit (must keep both `rust/automerge/Cargo.toml` and `javascript/package.json`
   at versions compatible with our consumers).
2. `git clone --depth 1 --branch <tag> https://github.com/automerge/automerge.git /tmp/automerge-vendor`.
3. `cp /tmp/automerge-vendor/automerge/javascript/src/{apply_patches,conflicts,constants,counter,immutable_string,implementation,internal_state,numbers,proxies,types}.ts ./` (overwrite the verbatim files).
4. Manually re-apply the local modifications to `low_level.ts` (or diff against upstream's new `low_level.ts` and merge).
5. Update this file with the new commit/date.
