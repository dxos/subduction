# Vendored `automerge-wasm`

Source: [`automerge/automerge` repository](https://github.com/automerge/automerge), tag
[`rust/automerge-0.8.0`](https://github.com/automerge/automerge/releases/tag/rust/automerge-0.8.0),
commit `8246d0f8218cd49dc1af56ba6eefd88ed215665c`.

Imported on **2026-05-05**.

## Why this is vendored

Upstream `automerge-wasm` is not published to crates.io (`publish = false` upstream). It exists only in the
`automerge/automerge` repository at `rust/automerge-wasm/`, where its `Cargo.toml` declares a path-relative
dependency on the in-tree `automerge` crate.

We need its `#[wasm_bindgen]` exports linked into `automerge_subduction_wasm`'s cdylib so the unified `.wasm`
artifact carries both Subduction and Automerge symbols. Vendoring is the cleanest way to do that without
fighting Cargo's source-of-truth rules for path-relative deps.

## Local modifications

The upstream tree was copied verbatim from `rust/automerge-wasm/` and then trimmed/edited:

| Path | Change |
|------|--------|
| `Cargo.toml` | `name`/`version`/`license`/`description`/`authors`/`repository` retained. The `automerge` dep now points at the workspace (`workspace = true`). `crate-type` reduced from `["cdylib", "rlib"]` to `["rlib"]` (cdylib emission is the unified crate's job; this crate is statically linked into it). External deps moved to `workspace = true` where the workspace already declares them. `wasm-bindgen` bumped from upstream's pinned `=0.2.108` to the workspace pin (`=0.2.118`) to match wasm-bindgen-cli used elsewhere in the workspace. `[lints] workspace = true` added so workspace-wide lints apply. `publish = false`. **`console_error_panic_hook` dependency removed** — the unified cdylib (`automerge_subduction_wasm`) is built with `panic=unwind`, so panics surface as `PanicError` exceptions at the JS boundary and the console hook adds nothing. |
| `deno-tests/`, `examples/`, `test/`, `tsconfig.json`, `package.json`, `fixup-node-cjs.mjs`, `PATCH.md` | Removed. JS/Deno scaffolding for upstream's npm publishing flow; not relevant here. |
| `src/lib.rs` | `init()` no longer calls `console_error_panic_hook::set_once();`. See the comment at that call site and the unified cdylib's `start()` (which installs `wasm_bindgen::__rt::set_on_abort` instead, for the rare hard-abort case). |
| `src/` (other files) | Untouched (treated as authored Rust code from import time forward). |
| `LICENSE`, `README.md` | Retained for attribution. |

## Re-vendoring procedure

If we ever need to refresh against a newer upstream:

1. Pick a target tag/commit (must keep `rust/automerge/Cargo.toml` `version` aligned with the workspace pin).
2. `git clone --depth 1 --branch <tag> https://github.com/automerge/automerge.git /tmp/automerge-vendor` and `cp -r /tmp/automerge-vendor/rust/automerge-wasm crates/automerge_wasm.new`.
3. Apply the same trim list as above.
4. Diff `crates/automerge_wasm` vs `crates/automerge_wasm.new` and merge by hand.
5. Update this file with the new commit/date.
