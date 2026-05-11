---
name: revendor-automerge-wasm
description: Refresh both vendored automerge bodies in the subduction repo (`crates/automerge_wasm/` Rust crate and `automerge_subduction_wasm/js/automerge/` TypeScript layer) from a chosen upstream `automerge/automerge` rev, in lockstep, preserving local divergences. Use when the user asks to bump, refresh, re-vendor, or upgrade automerge-wasm or the vendored automerge JS layer; when bumping `@automerge/automerge-repo` and needing to match its `@automerge/automerge` peer version; or when investigating "what version of automerge are we on?".
---

# Re-vendoring `automerge-wasm` and the JS layer

This skill captures the procedure to refresh both vendored automerge bodies in lockstep. Read it whenever you re-vendor.

## Mandatory pre-reads

Read these three files before doing anything destructive — they document the local divergences this skill must preserve:

- [`crates/automerge_wasm/VENDOR.md`](../../../crates/automerge_wasm/VENDOR.md) — Rust crate provenance and local mods.
- [`automerge_subduction_wasm/js/automerge/VENDOR.md`](../../../automerge_subduction_wasm/js/automerge/VENDOR.md) — JS layer provenance and `low_level.ts` injection pattern.
- [`automerge_subduction_wasm/AGENTS.md`](../../../automerge_subduction_wasm/AGENTS.md) — `Re-vendoring procedure`, `Local TypeScript fork divergences`, `Patches to wasm-bindgen output`, `Common pitfalls`.

## Step 1 — pick the target rev

Default heuristic: **pin to the upstream commit that bumped `javascript/package.json` to whatever version the downstream consumer resolves to** (typically `@automerge/automerge-repo`). Do not float to `main` HEAD without auditing workspace-pin ripples.

Why: workspace pins (`automerge`, `wasm-bindgen`, `rand`, `getrandom`, `sha2`) interact with the upstream tree. Picking the SHA that matches your downstream consumer's resolved peer version usually means *no workspace changes* — pure source refresh.

Procedure:

1. Read the consumer's `package.json` to find the `@automerge/automerge` semver range:
   ```sh
   curl -s https://registry.npmjs.org/@automerge/automerge-repo/<version> | jq '.dependencies."@automerge/automerge"'
   ```
2. Resolve that range to a concrete published version (latest matching on npm).
3. Find the upstream commit that bumped `javascript/package.json` to that version:
   ```sh
   gh api 'repos/automerge/automerge/commits?path=javascript/package.json&per_page=20' \
     | jq -r '.[] | "\(.sha[0:10]) \(.commit.message | split("\n")[0])"' | head -20
   ```
   Look for `vX.Y.Z` commit messages.
4. Verify at the chosen SHA: `rust/automerge-wasm/Cargo.toml` `wasm-bindgen` pin matches our workspace pin (currently `=0.2.118` — check `Cargo.toml` `[workspace.dependencies]`); `rust/automerge/Cargo.toml` `version` matches our workspace `automerge = "X.Y.Z"` pin (currently `0.8.0`).

If either pin diverges, see "Step 2 — workspace ripple audit". If they match, skip to Step 3.

## Step 2 — workspace ripple audit (only if pins diverge)

The crates we care about and where they live:

| Pin | Workspace `Cargo.toml` | Notes |
|-----|------------------------|-------|
| `automerge` | `automerge = "X.Y.Z"` | Resolves from crates.io, not the in-tree path. Bumping this is a separate decision from re-vendoring. |
| `wasm-bindgen` | `wasm-bindgen = "=0.2.X"` | Must match what `wasm-bodge`/`wasm-bindgen-cli` use in [`flake.nix`](../../../flake.nix). Bump both in lockstep. |
| `rand`, `getrandom`, `sha2`, `hexane` | various | Transitive of `automerge`; only relevant if you also bump the workspace `automerge` pin. |

Document any required workspace edits up front. Surface the decision to the user before proceeding — don't sneak workspace-wide ripples into a "re-vendor" PR.

## Step 3 — refresh the Rust crate

```sh
git clone --depth 1 https://github.com/automerge/automerge.git /tmp/automerge-vendor
cd /tmp/automerge-vendor && git fetch origin <SHA> --depth 1 && git checkout <SHA>
```

In our tree:

```sh
rm -rf crates/automerge_wasm/src
cp -r /tmp/automerge-vendor/rust/automerge-wasm/src crates/automerge_wasm/
```

Hand-merge [`crates/automerge_wasm/Cargo.toml`](../../../crates/automerge_wasm/Cargo.toml) against `/tmp/automerge-vendor/rust/automerge-wasm/Cargo.toml`. Preserve our local mods exactly (see [`VENDOR.md`](../../../crates/automerge_wasm/VENDOR.md) "Local modifications"):

- `crate-type = ["rlib"]` (not `["cdylib", "rlib"]`).
- `automerge = { workspace = true, features = ["wasm", "utf16-indexing"] }`.
- `js-sys`, `wasm-bindgen`, `thiserror` as `{ workspace = true }`.
- `console_error_panic_hook` dep removed; `default = []`.
- `[lints.rust]` and `[lints.clippy]` opt-out blocks (`= "allow"`).
- `publish = false`.
- `repository.workspace = true`, `authors.workspace = true`.

Re-apply [`src/lib.rs`](../../../crates/automerge_wasm/src/lib.rs) modification: `init()` must not call `console_error_panic_hook::set_once();`. Upstream's read-only sync work and other refactors may have moved `init()`; locate and re-strip the call.

Take any *new* deps upstream added that are not optional removals. Skip optional `wee_alloc`, `console_error_panic_hook`, and `[dev-dependencies]` (we removed dev/test scaffolding).

Update [`crates/automerge_wasm/VENDOR.md`](../../../crates/automerge_wasm/VENDOR.md) header: new SHA, "Imported on YYYY-MM-DD", note the npm `@automerge/automerge@X.Y.Z` correspondence.

Verify:

```sh
cargo check -p automerge_subduction_wasm --target wasm32-unknown-unknown
```

## Step 4 — refresh the JS layer

```sh
cp /tmp/automerge-vendor/javascript/src/{apply_patches,conflicts,constants,counter,immutable_string,implementation,internal_state,numbers,proxies,types}.ts \
  automerge_subduction_wasm/js/automerge/
```

These 10 files are vendored verbatim. Then:

### Re-port `low_level.ts`

Diff upstream's [`low_level.ts`](https://github.com/automerge/automerge/blob/main/javascript/src/low_level.ts) at the target SHA against ours. Merge their changes onto our injection pattern:

- Replace upstream's hard-coded `import { default as initWasm } from "./wasm_bindgen_output/web/automerge_wasm.js"` and `import * as WasmApi from "./wasm_bindgen_output/web/automerge_wasm.js"` with our parameter-injected `setWasmApi(api)` function.
- Keep top-level `isWasmLoaded` and `reinitWasmSync` exports that forward to the wasm-bindgen layer's patched additions.
- Keep `initializeWasm` resolving with the WebAssembly instance instead of `void`.

### Re-apply 2 TypeScript divergences

Per [`AGENTS.md`](../../../automerge_subduction_wasm/AGENTS.md) "Local TypeScript fork divergences":

1. [`implementation.ts`](../../../automerge_subduction_wasm/js/automerge/implementation.ts) `emptyChange` parameter: `void` → `undefined`. TS's `x === undefined` narrow does not strip `void` from a union ([microsoft/TypeScript#35857](https://github.com/microsoft/TypeScript/issues/35857)).
2. [`proxies.ts`](../../../automerge_subduction_wasm/js/automerge/proxies.ts) `reduce<U>(...)`: drop the explicit `<U>` type argument.

Each call site has an inline comment marking the divergence — preserve the comments.

### Refresh `wasm_types.d.ts`

```sh
cd /tmp && npm pack @automerge/automerge@<X.Y.Z>
tar -xzf automerge-automerge-<X.Y.Z>.tgz package/dist/wasm_types.d.ts
cp package/dist/wasm_types.d.ts <repo>/automerge_subduction_wasm/js/automerge/wasm_types.d.ts
```

Re-add the vendor header at the top of the copied file.

Update [`automerge_subduction_wasm/js/automerge/VENDOR.md`](../../../automerge_subduction_wasm/js/automerge/VENDOR.md) header.

## Step 5 — build, anchors, verify

```sh
cd automerge_subduction_wasm
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

If `pnpm build` throws "patch anchor not found" during the wasm-bindgen output patching step:

- Inspect `dist/wasm_bindgen/web/automerge_subduction_wasm.js`.
- Update the string-literal anchors in [`build_js.js`](../../../automerge_subduction_wasm/build_js.js)'s `patches` array to match the new wasm-bindgen output byte-for-byte.
- See [`AGENTS.md`](../../../automerge_subduction_wasm/AGENTS.md) "Patches to wasm-bindgen output" for context.

Anchors usually only shift on `wasm-bindgen` major/minor bumps. Patch bumps within the same minor (e.g. `0.2.118 → 0.2.118`) are stable.

Workspace verify:

```sh
cargo check --workspace --target wasm32-unknown-unknown
cargo deny check  # optional; surfaces duplicate-major issues
```

## Step 6 — surface follow-up

`pub use automerge_wasm::*;` in [`automerge_subduction_wasm/src/lib.rs`](../../../automerge_subduction_wasm/src/lib.rs) auto-re-exports new Rust exports at the wasm boundary. But our JS top-level wrappers ([`build_js.js`](../../../automerge_subduction_wasm/build_js.js)) and [`dist/index.d.ts`](../../../automerge_subduction_wasm/dist/index.d.ts) only mirror what's listed in the [surface contract](../../../automerge_subduction_wasm/AGENTS.md) "Surface contract" section.

If upstream added new public API (e.g. read-only sync `setReadOnly`/`isReadOnly`):

- Note it in the re-vendor commit message ("present at wasm boundary; not yet exposed at JS top level").
- Defer the surface addition to a separate follow-up PR.

## Common pitfalls

See [`AGENTS.md`](../../../automerge_subduction_wasm/AGENTS.md) "Common pitfalls" for: vitest discovery failure with `server.deps.inline`, `pnpm build` patch-anchor non-idempotency on standalone `build_js.js` runs, duplicate `automerge` versions in `cargo tree`.

Re-vendor-specific:

- **Drift to `main` HEAD**: tempting but usually wrong. Pin to the SHA your downstream consumer's `^X.Y.Z` resolves to. If a newer patch publishes after your re-vendor, re-pin; don't drift.
- **Forgetting the `init()` panic-hook strip**: builds will succeed but the unwound-panic console-spam regression is silent. Diff `src/lib.rs` against the previous vendor before committing.
- **`wasm_types.d.ts` from the wrong source**: must come from `npm pack @automerge/automerge@<version>`, not from the upstream git tree. The git tree's `dist/` is gitignored; the npm tarball contains the published, generated `.d.ts`.
- **Trailing-newline churn in `package.json`**: `wasm-bodge build` rewrites `package.json` and may strip the final newline. Re-add it before committing if `git diff` shows `\ No newline at end of file`.

## Commit hygiene

Commit chunks separately for reviewability:

1. Skill / docs updates.
2. Workspace pin bumps (only if Step 2 produced any).
3. Rust vendor refresh (`crates/automerge_wasm/`).
4. JS vendor refresh (`automerge_subduction_wasm/js/automerge/`).
5. Any `build_js.js` anchor fix from Step 5.

Reference the upstream SHA in commit messages so future re-vendor diffs are easy to scope.
