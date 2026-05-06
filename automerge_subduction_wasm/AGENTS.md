# `@dxos/automerge-subduction` agent guide

This document captures non-obvious knowledge needed to maintain `automerge_subduction_wasm` (the package
published as `@dxos/automerge-subduction`). Read this before changing anything in this directory or the related
vendored crate at `crates/automerge_wasm/`.

For the full architectural intent, see [`subduction_keyhive/UNIFIED_AUTOMERGE_SUBDUCTION_WASM_SPEC.md`](../subduction_keyhive/UNIFIED_AUTOMERGE_SUBDUCTION_WASM_SPEC.md).

For provenance details, see [`crates/automerge_wasm/VENDOR.md`](../crates/automerge_wasm/VENDOR.md) and
[`js/automerge/VENDOR.md`](js/automerge/VENDOR.md).

## What this package does

This package serves both Automerge document APIs (the upstream `@automerge/automerge` `next` namespace) and
Subduction/Sedimentree replication APIs from a **single shared WebAssembly module**. The motivation is Cloudflare
Workers memory pressure: loading two wasm-bindgen packages means two linear memories, two allocators, two
duplicated baselines. Folding everything into one cdylib eliminates the duplication.

The Automerge runtime surface is published under DXOS's npm scope; the npm package name is
`@dxos/automerge-subduction` and the version starts at `0.1.0`.

## Mental model

```
JS consumer
    │
    ▼
dist/esm/<target>.js                       ← per-target wrapper, env-specific wasm load
    │  (env-specific init: readFileSync / atob / static .wasm import / etc.)
    │  setWasmApi(wasmModule)
    ▼
dist/automerge/implementation.js           ← high-level next API: init, change, save, ...
    │
    │  reads ApiHandler                    ← populated by setWasmApi
    ▼
dist/automerge/low_level.js                ← ApiHandler table + setWasmApi + initializeWasm
    │
    │  delegates to
    ▼
dist/wasm_bindgen/web/automerge_subduction_wasm.js     ← the wasm-bindgen-emitted glue
    │
    │  loads
    ▼
dist/automerge-subduction.wasm             ← the actual cdylib output (~2.4 MB optimized)
```

Every per-target wrapper imports from the **same** `dist/wasm_bindgen/web/automerge_subduction_wasm.js`. ES module
singleton semantics (the same module instance is shared across all importers in a process) mean they all share
one `wasm` variable. This is wasm-bodge's "shared web target" architecture; do not import from per-target
subdirectories of `dist/wasm_bindgen/`.

## Critical files

| Path | Purpose |
|------|---------|
| `Cargo.toml` | Rust crate manifest. Adds `automerge-wasm = { workspace = true }` to fold the vendored crate's wasm-bindgen exports into our cdylib. |
| `src/lib.rs` | Rust entrypoint. Has `pub use automerge_wasm::*;` (and the same for sister wasm crates). The single `#[wasm_bindgen(start)]` lives here, gated on `feature = "standalone"`. |
| `package.json` | npm publish identity: `name`, `version`, `exports` map, `scripts`. The build/test/typecheck scripts run from here. The `build` script chains `build_wasm.mjs` and `build_js.js`. |
| `build_wasm.mjs` | Wraps `wasm-bodge build` so the `panic=unwind` build options are applied (nightly toolchain, `wasm-release` profile, `-Zbuild-std`). See "Panic strategy" below. |
| `build_js.js` | Post-`wasm-bodge` build orchestrator. Compiles vendored TS, patches wasm-bindgen output, writes per-target wrappers, emits `dist/index.d.ts`. The biggest piece of authored JS in the package. |
| `tsconfig.json` | TS config for compiling `js/automerge/` and `js/src/` (if any) to `dist/`. `rootDir = ./js`, `outDir = ./dist`. |
| `tsconfig.test.json` | Stricter TS config used by `pnpm typecheck`. Overrides `rootDir = ./test`. |
| `vitest.config.ts` | Runtime test runner config. Don't add `server.deps.inline: true` — it silently breaks test discovery. |
| `js/automerge/` | **Vendored** Automerge JS layer (see [VENDOR.md](js/automerge/VENDOR.md)). |
| `js/automerge/wasm_types.d.ts` | TS declarations for the wasm-bindgen API. Vendored from upstream npm `@automerge/automerge@3.2.5/dist/wasm_types.d.ts`. Must match the API our vendored Rust crate produces. |
| `test/` | Vitest suite. Tests import from `../dist/esm/node.js` (the built package), never from sources or upstream. |

## Critical files outside this package

- `crates/automerge_wasm/` — Vendored upstream `automerge-wasm` Rust crate (see
  [VENDOR.md](../crates/automerge_wasm/VENDOR.md)). Member of the workspace. **Must remain `crate-type = ["rlib"]`**;
  if it emits its own `cdylib` we get a second `.wasm` file and the unification breaks.
- Workspace `Cargo.toml` — Declares `automerge-wasm` in `[workspace.dependencies]` so we can `workspace = true`.
- `nix/commands.nix` — `ci` recipe step 8/8 runs this package's `pnpm build && typecheck && test`.

## Build pipeline (`pnpm build`)

`pnpm build` runs in two phases:

### Phase 1: `node ./build_wasm.mjs` → `wasm-bodge build`

`build_wasm.mjs` wraps the `wasm-bodge` invocation to apply the panic=unwind options (see "Panic strategy"
below): selects the pinned nightly toolchain, passes `--profile wasm-release`, and lets cargo pick up the
`[unstable] build-std` setting from `.cargo/config.toml`. Then bodge does:

1. `cargo build --target wasm32-unknown-unknown --profile wasm-release` (rebuilding std with the unwind
   panic runtime via `-Zbuild-std`).
2. `wasm-opt -Oz` on the resulting `.wasm`.
3. `wasm-bindgen --target {nodejs, web, bundler}` produces three sets of JS glue under
   `dist/wasm_bindgen/<target>/`.
4. Bodge writes thin per-target wrappers in `dist/esm/`, `dist/cjs/`, `dist/iife/` that re-export from the
   web target.
5. Bodge **strips unrecognized keys** from `package.json` `exports`. Our `./automerge.wasm` alias is one such
   stripped key; `build_js.js` re-adds it.

### Phase 2: `node ./build_js.js`

In order:

1. Compile vendored TS layer (`js/automerge/*.ts`) to `dist/automerge/*.{js,cjs,d.ts}` (esbuild for JS/CJS, tsc
   for `.d.ts`).
2. Apply textual patches to `dist/wasm_bindgen/web/automerge_subduction_wasm.js` (the workstream-5b additions —
   see "Patches to wasm-bindgen output" below).
3. Generate `dist/esm/wasm-base64.js` and `dist/cjs/wasm-base64.cjs` from the wasm asset.
4. **Overwrite** bodge's default per-target wrappers in `dist/esm/<target>.js` and write hand-coded CJS
   counterparts (which use `__dirname`/`require` directly to avoid `import.meta` pitfalls in CJS).
5. Bundle IIFE from the web wrapper (with `--define:import.meta.url='"file:///"'` to neutralize the dead
   URL-fetch path).
6. Re-add `./automerge.wasm` to `package.json` `exports`.
7. Emit `dist/index.d.ts` and per-target `.d.ts` shims.
8. Copy `js/automerge/wasm_types.d.ts` to `dist/automerge/`.

After phase 2, `find dist -name '*.wasm'` lists exactly one file: `dist/automerge-subduction.wasm`.

## Patches to wasm-bindgen output

`build_js.js` modifies `dist/wasm_bindgen/web/automerge_subduction_wasm.js` after each build to add two functions
that `@dxos/edge` and similar consumers need. **Do not commit these patches to upstream wasm-bindgen.**

The reference patch is `dxos/edge` `patches/@automerge__automerge@3.1.1.patch`. Note that patch was authored
against `wasm-bindgen 0.2.108`. We pin `wasm-bindgen = "=0.2.118"` workspace-wide
([`/Cargo.toml`](../Cargo.toml)), and that newer version **already declares `let wasmModule, wasm;` at the top of
the generated module** and caches `wasmModule = module;` inside `__wbg_finalize_init`. So three of the patch's
four edits are redundant for us.

What we still patch:

1. Comment out the `if (wasm !== undefined) return wasm;` early-return inside `initSync` (so `reinitWasmSync` can
   re-instantiate).
2. Comment out the same guard inside `__wbg_init` (so async re-init works).
3. Add two new functions at the end:
   ```js
   function isWasmLoaded() { return wasmModule !== undefined; }
   function reinitWasmSync() {
     if (wasmModule === undefined) {
       throw new Error('reinitWasm called before wasm was initialized.');
     }
     return initSync({ module: wasmModule });   // wrap to suppress deprecation warning
   }
   ```
4. Extend the trailing export from `export { initSync, __wbg_init as default };` to include the new functions.

The patches use **string-literal anchors** that must match the wasm-bindgen output byte-for-byte. If
`wasm-bindgen` is bumped, expect to re-derive the anchors. Each substitution wraps in an existence check that
throws if the anchor isn't found, so a wasm-bindgen change fails the build loudly rather than silently no-op-ing.

## Panic strategy: `panic=unwind` for graceful Workers behaviour

This cdylib is the only one in the workspace built with `panic = "unwind"`. The motivation is Cloudflare Workers:
when a wasm module aborts on a panic, the entire Worker isolate is torn down, killing every in-flight request
in the same isolate, not just the offending one. With unwind, individual panics surface as JS `PanicError`
exceptions (caught at the wasm-bindgen boundary, 0.2.118+) and the isolate keeps serving other requests.

Three pieces make this work:

1. **`[profile.wasm-release]`** in the workspace [`Cargo.toml`](../Cargo.toml) inherits `release` and overrides
   `panic = "unwind"`. The `release` profile itself stays on `panic = "abort"` (smaller CLI binary). Only this
   crate is built with `wasm-release`.
2. **`[unstable] build-std = ["std", "panic_unwind", "panic_abort"]`** in
   [`.cargo/config.toml`](../.cargo/config.toml) makes nightly cargo rebuild std with **both** panic runtimes.
   Without it the prebuilt wasm32 std is hard-coded to `panic_abort` and the profile's `panic = "unwind"`
   setting is silently inert. We list `panic_abort` *too* (not just `panic_unwind`) because the sister wasm
   crates (`subduction_wasm`, `sedimentree_wasm`, `automerge_sedimentree_wasm`) all declare
   `crate-type = ["cdylib", "rlib"]`, and cargo emits **both** crate types for every dep in the build graph
   even when only the rlib is consumed. Their cdylib emission uses the wasm32 default panic strategy
   (`abort`), so without `panic_abort` available it errors with `can't find crate for panic_abort`. Building
   both runtimes is the cheap fix; the alternative — rewriting every sister crate to gate `cdylib` away when
   it's a transitive dep — would require structural changes to those crates' published packages. The
   `[unstable]` section is ignored by stable cargo, so it does not affect builds of the rest of the workspace.
3. **A pinned nightly toolchain** is required for `-Zbuild-std`. We pin `nightly-2026-04-25` (matching the
   upstream automerge PR that introduced this approach). Selection happens via `RUSTUP_TOOLCHAIN` (rustup-based
   dev) or `WASM_RUST_BIN_DIR` PATH-prepend (nix shell, see [`flake.nix`](../flake.nix)).
   [`automerge_subduction_wasm/build_wasm.mjs`](./build_wasm.mjs) and the `bodge`/`release:wasm:*` recipes in
   [`nix/commands.nix`](../nix/commands.nix) honour both paths; bump the pinned date deliberately if you need to
   (single-source: edit `WASM_TOOLCHAIN_DEFAULT` in `build_wasm.mjs` and `wasmToolchainDate` in `flake.nix`).

The vendored `crates/automerge_wasm` no longer depends on `console_error_panic_hook`. The reason is stronger
than "redundant": with `panic=unwind`, wasm-bindgen 0.2.118+ converts unwound panics into `PanicError`
exceptions that callers can catch and handle. Reinstalling the console hook on top of that would cause every
*caught and recovered* panic to also dump a stack trace to `console.error`, which defeats the point of
exposing panics as catchable exceptions — a Worker that gracefully handles a panic from one bad request would
still spam its logs with that panic's stack trace. See
[`crates/automerge_wasm/VENDOR.md`](../crates/automerge_wasm/VENDOR.md) for the local modification record and
the [upstream PR commit message](https://github.com/automerge/automerge/pull/1363) for the same argument.

For *hard* aborts the unwind runtime cannot recover from (OOM, stack overflow, instance termination — anywhere
wasm traps and the module is permanently torn down), `start()` installs a `wasm_bindgen::__rt::set_on_abort`
callback that logs an explanation to the console. The handler is a plain `fn()` with no captures (the API
stores it as a `u32` index into the wasm function table, so closures are not allowed). Without this hook,
every subsequent export call after an abort just throws the opaque "Module terminated" error with no breadcrumb
trail.

### Why only this cdylib uses `panic=unwind`

The workspace contains four wasm cdylib crates: `sedimentree_wasm`, `subduction_wasm`,
`automerge_sedimentree_wasm`, and this one. **Only `automerge_subduction_wasm` is built with `wasm-release`
(unwind);** the others still use `release` (abort).

This asymmetry is a deliberate scope decision, not a principled distinction. The Workers target ships *this*
crate, so the panic-survival benefit is concrete here. The other three are still useful as standalone wasm
packages but currently have no consumer running them in a multi-tenant isolate where one bad request can take
down nine others. Upstream's
[PR review thread](https://github.com/automerge/automerge/pull/1363) made the case that "the build hassle is
worth it" and flipped unwind from opt-in to default for their single cdylib. By the same logic, we should flip
the other three eventually — the only thing keeping them on abort is that we haven't paid the build-pipeline
cost (extending the nightly toolchain provisioning to all four). When a contributor needs panic-survival in a
sister wasm crate, lift the `wasm-release` profile + `WASM_RUST_BIN_DIR` plumbing from this crate's
`build_wasm.mjs` and the `nix/commands.nix` recipes; the workspace `Cargo.toml` profile and
`.cargo/config.toml` already cover any wasm cdylib.

### Building this crate without the nix shell

You need rustup with the pinned nightly + `rust-src`:

```sh
rustup toolchain install nightly-2026-04-25 --profile minimal --component rust-src
rustup target add wasm32-unknown-unknown --toolchain nightly-2026-04-25
```

Then `pnpm build` in this directory works as usual. `build_wasm.mjs` will set `RUSTUP_TOOLCHAIN` to the pin so
`wasm-bodge`'s internal `cargo` invocation lands on nightly.

Override the pin via the `WASM_TOOLCHAIN` env var (e.g. `WASM_TOOLCHAIN=nightly pnpm build` to float on latest
nightly).

## Why we don't `import.meta.url` in CJS bundles

`import.meta` is a parse error in CJS. esbuild emits `undefined` and a warning, but the warning was confusing in
build output. We avoid this by **hand-writing** the CJS variants (`dist/cjs/node.cjs` etc.) directly in
`build_js.js` rather than bundling from the ESM wrappers. The hand-coded CJS uses `__dirname` and `require()`
natively.

## Why every wrapper imports from `dist/wasm_bindgen/web/`

Per [wasm-bodge's docs](https://github.com/alexjg/wasm-bodge#shared-web-target-architecture), there is no
`wasm-bindgen --target workerd` and no separate `--target slim`. Bodge produces three wasm-bindgen targets
(`nodejs`, `web`, `bundler`) and uses the `web` target's JS module as the runtime for **all** entrypoints. The
others contribute only:

- `nodejs` — `.d.ts` types and a `.cjs` wrapper used by `dist/cjs/node.cjs`.
- `bundler` — the `_bg.wasm` loader used by `dist/esm/bundler.js`.

Our per-target wrappers import everything from `../wasm_bindgen/web/automerge_subduction_wasm.js` regardless of
which environment they target. The wasm load mechanism (file read / base64 / static import / etc.) varies but
the resulting `wasm` variable lives in **the same web-target module instance** thanks to ES module singleton
semantics. This is what makes `dist/esm/web.js` and `dist/esm/slim.js` share the same wasm instance once one of
them initializes.

## Single-WASM regression

The whole point of this package is one wasm module. There is currently **no automated regression test** that
asserts only one `WebAssembly.Module` is instantiated per process — `test/init.test.ts` checks idempotency of
`initializeWasm`, which is close but not the same. If you add new entrypoints or change wrapper init logic,
manually verify with:

```js
const orig = WebAssembly.Module
let count = 0
WebAssembly.Module = function (...args) { count++; return new orig(...args) }
WebAssembly.Module.prototype = orig.prototype
import('./dist/esm/node.js').then(() => console.log('Modules:', count))
// expect: 1
```

## Surface contract

What the package re-exports at the top level (per
[the spec](../subduction_keyhive/UNIFIED_AUTOMERGE_SUBDUCTION_WASM_SPEC.md)):

**Automerge `next` functions:** `init`, `load`, `loadIncremental`, `change`, `emptyChange`, `free`, `getHeads`,
`diff`, `save`, `saveSince`, `initSyncState`, `encodeSyncState`, `decodeSyncState`, `receiveSyncMessage`,
`generateSyncMessage`, `decodeSyncMessage`, `stats`, `RawString`.

**WASM lifecycle:** `initializeWasm`, `initializeBase64Wasm` (alias `initFromBase64Wasm`), `isWasmInitialized`,
`isWasmLoaded`, `reinitWasmSync`, `wasmInitialized`.

**`next` namespace:** `next.*` mirrors all of `dist/automerge/implementation.js`'s exports for consumers
familiar with `import { next } from '@automerge/automerge'`.

**Subduction surface:** `Subduction`, `MemorySigner`, `CommitId`, `CommitWithBlob`, `FragmentWithBlob`,
`SedimentreeId`, `SignedFragment`, `SignedLooseCommit`, plus concrete classes (`AuthenticatedTransport`,
`MessagePortTransport`, `MemoryStorage`, `IndexedDbStorage`, `SedimentreeAutomerge`, `SubductionWebSocket`,
`SubductionLongPoll`, `SubductionHttpLongPoll`, `Sedimentree`, `Digest`, `PeerId`, `WebCryptoSigner`,
`Fragment`, `FragmentRequested`, `FragmentState`, `FragmentStateStore`, `LooseCommit`).

**Spec deviation:** the spec lists `Transport` and `SedimentreeStorage` but those names are conceptual and not
actually exported by the Rust crates. The concrete classes above replace them.

**Types:** `Doc`, `ApplyOptions` (from vendored `implementation.d.ts`); `Heads`, `SyncState`, `Patch`, `PutPatch`,
`SpliceTextPatch`, `Prop` (from vendored `wasm_types.d.ts`).

## Re-vendoring procedure

Both vendored bodies (`crates/automerge_wasm/` and `js/automerge/`) come from the same upstream rev so they
should be re-vendored together.

### Pick a new rev

The new rev's `automerge/automerge` repo must satisfy:
- `rust/automerge/Cargo.toml` `version` matches what we pin in [`/Cargo.toml`](../Cargo.toml). Currently `0.8.0`.
  If we want to bump, also bump the workspace `automerge` dep in lockstep.
- `javascript/package.json` is still on a 3.x line (DXOS Edge expects 3.x JS API shape).

`git tag --list 'rust/automerge-*'` in a fresh clone of `automerge/automerge` lists candidate revs.

### Refresh the Rust crate

```bash
git clone --depth 1 --branch rust/automerge-<X.Y.Z> https://github.com/automerge/automerge.git /tmp/automerge-vendor
rm -rf crates/automerge_wasm/src
cp -r /tmp/automerge-vendor/automerge/rust/automerge-wasm/src crates/automerge_wasm/
# Manually re-merge `crates/automerge_wasm/Cargo.toml` against upstream (see VENDOR.md "Local modifications")
# Update `crates/automerge_wasm/VENDOR.md` with the new rev/date.
cargo check -p automerge_subduction_wasm --target wasm32-unknown-unknown
```

### Refresh the JS layer

```bash
cp /tmp/automerge-vendor/automerge/javascript/src/{apply_patches,conflicts,constants,counter,immutable_string,implementation,internal_state,numbers,proxies,types}.ts \
  automerge_subduction_wasm/js/automerge/
# Manually re-merge low_level.ts: diff upstream's against ours, port their changes onto our setWasmApi/inject pattern.
npm pack @automerge/automerge@<NEW_NPM_VERSION>
tar -xzf automerge-automerge-<NEW_NPM_VERSION>.tgz package/dist/wasm_types.d.ts
cp package/dist/wasm_types.d.ts automerge_subduction_wasm/js/automerge/wasm_types.d.ts
# (re-add the vendor header at the top)
# Update js/automerge/VENDOR.md with the new rev/date.
```

### Verify wasm-bindgen patch anchors still match

Run `pnpm build`. If the `build_js.js` patch step throws "patch anchor not found", inspect
`dist/wasm_bindgen/web/automerge_subduction_wasm.js` and update the anchor strings in `build_js.js`. The
substitutions are listed inline in `build_js.js`'s `patches` array.

## Common pitfalls

### "No test suite found in file" from vitest

You added `server.deps.inline: true` (or similar deep config) to `vitest.config.ts`. That setting silently
breaks test discovery in Vitest 2.x. Keep `vitest.config.ts` minimal.

### `pnpm build` fails with "patch anchor not found"

Either:
- wasm-bindgen was bumped and its output structure changed. Update the anchors in `build_js.js`.
- You ran `node ./build_js.js` standalone twice without re-running bodge in between. The patches are not
  idempotent against an already-patched file. Run `pnpm build` (which re-runs bodge first).

### `cargo build` fails with "expected `ChangeHash`, found `ChangeHash`"

Two `automerge` crates in the build graph. Usually because someone added a git or path dep that pulls a
different `automerge` version. Run `cargo tree -p automerge_subduction_wasm | grep automerge` and ensure exactly
one `automerge` line (with `(*)` markers for repeats). The vendored `crates/automerge_wasm` must depend on
`automerge = { workspace = true }`, never path-relative.

### Local TypeScript fork divergences in `js/automerge/`

Two minimal type-tightening edits sit on top of the otherwise-verbatim upstream vendor (see
[`js/automerge/VENDOR.md`](js/automerge/VENDOR.md)):

1. `implementation.ts` `emptyChange` parameter: `void` → `undefined`. TS's `x === undefined` narrow does
   not strip `void` from a union ([microsoft/TypeScript#35857](https://github.com/microsoft/TypeScript/issues/35857)),
   so upstream's mutation-narrow pattern emits phantom errors against `options.time` / `options.message`.
2. `proxies.ts` `reduce<U>(...)`: dropped the explicit `<U>` type argument. The proxy methods' `this` is
   untyped, which makes `this.toArray()` return `any`; TS rejects explicit type arguments on untyped calls
   even though sibling methods (`reduceRight`, `map`) use the same shape without annotation.

Each call site has an inline comment marking the divergence. **Total cost at re-vendor: ~2 lines of conflict.**
Re-apply by repeating the edits and the comments after running the re-vendor procedure.

If a future re-vendor fixes these upstream, drop the local divergence and the comments — `pnpm build` will
keep working either way.

### "using deprecated parameters for `initSync()`" warning

`reinitWasmSync()` calls `initSync(wasmModule)` with a raw `WebAssembly.Module`. wasm-bindgen 0.2.118 prefers
`{ module: wasmModule }`. The patch in `build_js.js` wraps it correctly. If you see this warning, you've broken
the patch — check `dist/wasm_bindgen/web/automerge_subduction_wasm.js` near the bottom for `return initSync(...)`.

### Bodge strips your `package.json` exports addition

`wasm-bodge build` rewrites `package.json`'s `exports` map and removes any keys it doesn't recognize. To add a
new export key, add it back in `build_js.js`'s "re-add ./automerge.wasm export alias" step.

### `dist/wasm_bindgen/<target>/` files are mostly identical at runtime

They are. Per wasm-bodge's design, only `dist/wasm_bindgen/web/` is consumed at runtime. The `nodejs/` directory
is consumed only for `.d.ts`. The `bundler/` directory is consumed only for the `_bg.wasm` loader by
`dist/esm/bundler.js`. Don't import from `nodejs/` or `bundler/` in any of our wrappers.

### `dist/automerge/` looks "weird" in VS Code

VS Code's TypeScript-aware file nesting (`explorer.fileNesting.enabled`) groups `.js` with its `.d.ts` and
`.map` siblings under a fake parent. The actual filesystem is flat. Run `ls dist/automerge/` to see the truth.

## Workspace lints opt-out for vendored crate

Workspace `[lints.clippy]` is `pedantic = "deny"` and `cargo = "deny"`. Vendored `automerge-wasm` doesn't pass
those lints (upstream uses patterns we don't audit). [`crates/automerge_wasm/Cargo.toml`](../crates/automerge_wasm/Cargo.toml)
opts out:

```toml
[lints.rust]
missing_docs = "allow"
missing_debug_implementations = "allow"
missing_copy_implementations = "allow"

[lints.clippy]
all = "allow"
pedantic = "allow"
cargo = "allow"
```

Don't propagate this opt-out to other crates. The workspace-wide strictness is intentional; only vendored code
gets a pass.

## Out-of-scope

These are explicitly **not** in this package's responsibility:

- **Memory benchmark** vs. the two-package baseline (`@automerge/automerge` + old `@automerge/automerge-subduction`).
  Spec marks it out of scope; verify with DXOS Edge's real workload after migration.
- **DXOS Edge's migration to this package.** Consumer-side concern.
- **Sister wasm packages** (`subduction_wasm`, `automerge_sedimentree_wasm`, `sedimentree_wasm`). Their dead
  `wasm-pack`-based scripts and `./debug` exports remain; cleaning those is a separate cross-package concern.
- **Shipping a `./debug` variant.** Dropped; the `wasm-debug` Cargo profile in [`/Cargo.toml`](../Cargo.toml)
  remains for local browser-DevTools debugging via `wasm-bodge build --debug-profile wasm-debug ...` but does
  not ship to npm.

## Identity placeholders

These `package.json` fields point at upstream Subduction (inkandswitch) and need DXOS team input before publish:

- `repository.url` — currently `https://github.com/inkandswitch/subduction`. Change to a DXOS-controlled URL when
  the team picks one (DXOS monorepo path or a dedicated repo).
- `repository.directory` — drop or update if `repository.url` no longer points at the inkandswitch monorepo.
- `homepage`, `bugs.url` — align with whichever `repository.url` is chosen.
- `author` — currently the original Subduction authors (Alex Good, Brooklyn Zelenka). Likely needs a DXOS contact
  added (or moved to `contributors`).

## CI

The package's build and test run as step 8/8 of [`nix/commands.nix`](../nix/commands.nix) `ci` recipe:

```sh
cd "$WORKSPACE_ROOT/automerge_subduction_wasm"
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm install --frozen-lockfile` requires `pnpm-lock.yaml` to be committed and current. After dependency
changes, run `pnpm install` (no flag) locally and commit the lockfile change.

`pnpm build` re-runs `wasm-bodge build` even if `bodge:all` already ran in CI step 6. The redundant ~5 seconds
keeps this package's build self-contained. If desired in the future, `automerge_subduction_wasm` can be excluded
from `bodge:all`'s loop and rely solely on `pnpm build`.

## Test summary

44 tests across 7 files in `test/`:

- `init.test.ts` — `initializeWasm`/`isWasmInitialized`/`isWasmLoaded`/`reinitWasmSync` lifecycle.
- `automerge_doc.test.ts` — `init`/`change`/`save`/`load`/`loadIncremental`/`saveSince`/`diff`/`stats`/`RawString`.
- `automerge_sync.test.ts` — sync state messages converging two docs.
- `subduction_surface.test.ts` — every Subduction class is a constructor and instantiates.
- `sedimentree_integration.test.ts` — `SedimentreeAutomerge` exists alongside the JS layer (proves shared wasm).
- `dist_layout.test.ts` — published directory shape, no debug variants.
- `no_upstream_imports.test.ts` — `dist/` runtime files don't import `@automerge/automerge` or self.
- Plus `types.test-d.ts` (TS-only assertions, run via `pnpm typecheck`).
