# `automerge_subduction_wasm` Unified Re-Export Spec

## Summary

Extend the existing `automerge_subduction_wasm` package and republish it under the DXOS scope as
`@dxos/automerge-subduction` (starting at version `0.1.0`) so that it re-exports the Automerge `next` API
surface alongside its existing Subduction/Sedimentree surface, served by a single shared WebAssembly module.

After this change, downstream consumers (e.g. DXOS Edge) import both Automerge document APIs and Subduction
replication APIs from `@dxos/automerge-subduction` and never load `@automerge/automerge`'s WASM separately.

This is an in-place evolution of the existing package source at `automerge_subduction_wasm/`. The publish identity
changes (`name`, `version`, `repository.url`, `author`) to reflect DXOS as the publisher; the existing
`@automerge/automerge-subduction` published name is **not** maintained going forward (no migration path; consumers
update imports).

## Motivation

Cloudflare Workers run with a hard memory budget per isolate. Loading `@automerge/automerge` and the existing
`@automerge/automerge-subduction` as separate packages means two `wasm-bindgen` modules with two independent linear
memories, two allocators, and duplicated baseline cost. Folding Automerge's wasm-bindgen exports into the same
cdylib that already produces Subduction's wasm-bindgen exports eliminates the duplicated baseline. Linear memory
high-water-mark per operation is unaffected; this is explicitly not a fix for Automerge OOMs on a single large
operation.

## Goals

- Produce exactly one production `.wasm` file from `automerge_subduction_wasm`.
- Have one Rust dependency graph, one wasm-bindgen module, one allocator, and one WASM linear memory backing both
  Automerge document APIs and the Subduction replication APIs.
- Expose a JavaScript surface from `@dxos/automerge-subduction` that matches the listed Automerge `next` API
  closely enough that DXOS Edge can swap upstream imports with a thin compatibility wrapper.
- Preserve the package's existing Subduction surface and the release-only entrypoints
  (`node`/`web`/`workerd`/`bundler`/`slim`/`wasm`/`wasm-base64`/`iife`). Drop the `./debug` family of subpath
  exports.

## Non-Goals

- Do not reimplement Automerge or Subduction core logic.
- Do not aim to be a complete drop-in replacement for every upstream `@automerge/automerge` API on day one. Only
  the surface listed in [Required Automerge Surface](#required-automerge-surface) is in scope.
- Do not retain a debug WASM in the production export path.
- Do not attempt to fix Automerge OOM cases driven by single large operations. The unified module reduces
  duplicated baseline, not peak per-op memory.

## Required Automerge Surface

The package must re-export the following from `@dxos/automerge-subduction` (and from
`@dxos/automerge-subduction/slim`), matching the shape of `@automerge/automerge`'s `next` namespace.

Functions:

- `init`
- `load`
- `loadIncremental`
- `change`
- `emptyChange`
- `free`
- `getHeads`
- `diff`
- `save`
- `saveSince`
- `initSyncState`
- `encodeSyncState`
- `decodeSyncState`
- `receiveSyncMessage`
- `generateSyncMessage`
- `decodeSyncMessage`
- `stats`

Additional runtime exports:

- `RawString`
- `initializeWasm` (must resolve with the instantiated WebAssembly instance, not `void`, so callers can pass it
  to `reinitWasmSync`-aware tooling).
- `isWasmInitialized` (returns whether `UseApi` has been called against an instantiated module).
- `isWasmLoaded` (returns whether the wasm-bindgen layer has cached a module reference; distinct from
  `isWasmInitialized` because the module can be loaded but not yet swapped in via `UseApi`).
- `reinitWasmSync` (synchronously re-instantiates the cached wasm module; used to reset linear memory in
  long-lived hosts like Cloudflare Workers between requests). Throws if no module has been loaded yet.
- A default WASM URL/asset export at `@dxos/automerge-subduction/automerge.wasm` that resolves to the same
  `.wasm` file the package itself uses (i.e. an alias of the package's primary `./wasm` entry).

`isWasmLoaded` and `reinitWasmSync` mirror the patch DXOS Edge currently maintains against
`@automerge/automerge` 3.1.1 (see `dxos/edge` `patches/@automerge__automerge@3.1.1.patch`). Behavior must match:

- A `wasmModule` reference is cached the first time `initSync(...)` is called inside the wasm-bindgen output.
- `isWasmLoaded()` returns `wasmModule !== null`.
- `reinitWasmSync()` calls `initSync(wasmModule)` again to reset linear memory, throwing if no module is cached.
- The internal "already initialized" guards in both `initSync` and `__wbg_init` must be removed so re-entry
  works.

TypeScript types (must be exported from the package's main types entry):

- `Doc`
- `Heads`
- `SyncState`
- `Patch`
- `PutPatch`
- `SpliceTextPatch`
- `Prop`
- `ApplyOptions`

## Required Subduction Surface

The package must continue to export (from `@dxos/automerge-subduction`):

- `MemorySigner`
- `Subduction`
- `Transport`
- `CommitId`
- `CommitWithBlob`
- `FragmentWithBlob`
- `SedimentreeId`
- `SedimentreeStorage`
- `SignedFragment`
- `SignedLooseCommit`

Existing exports beyond this list (e.g. `SedimentreeAutomerge`, `AuthenticatedTransport`, `SubductionWebSocket`,
`SubductionLongPoll`, `Digest`, `PeerId`, etc.) must remain exported. The listed names are the contractually
required minimum.

## Implementation Strategy

### Rust crate

`automerge_subduction_wasm/` is the only `cdylib` in this repository that contributes to the published JS package.
The upstream `automerge-wasm` Rust crate (the wasm-bindgen producer that backs `@automerge/automerge`) is **not**
published to crates.io. We **vendor** it: copy `rust/automerge-wasm/` from a pinned upstream rev (see
[`UNIFIED_AUTOMERGE_SUBDUCTION_WASM_SPEC` plan, workstream 1b](#)) into a new `crates/automerge_wasm/` member of
this workspace and treat it as our authored Rust code.

The vendored crate's `Cargo.toml` is edited so it depends on the workspace `automerge` (no path-relative dep), and
its `[lib] crate-type` is changed from `["cdylib", "rlib"]` to `["rlib"]` only — it must not emit its own `.wasm`;
its symbols are linked into `automerge_subduction_wasm`'s cdylib. The vendored crate is added to
`[workspace.dependencies]` so other workspace members can write `automerge-wasm = { workspace = true }`.

In `automerge_subduction_wasm/Cargo.toml`:

```toml
[dependencies]
automerge-wasm = { workspace = true, default-features = false }
# existing deps remain:
automerge = { workspace = true, features = ["wasm"] }
automerge_sedimentree_wasm = { workspace = true }
subduction_wasm = { workspace = true }
# ...
```

Constraints:

- Exactly one `#[wasm_bindgen(start)]` may exist in the final cdylib. Disable any `standalone`-equivalent feature
  on `automerge-wasm`, `subduction_wasm`, and `automerge_sedimentree_wasm` when used as deps here.
  `automerge_subduction_wasm` already gates its own start function behind the `standalone` feature; preserve that
  pattern.
- Do not add a second cdylib for Automerge bindings. There must remain exactly one final WASM artifact.
- `wasm-opt -Oz` settings already declared in `automerge_subduction_wasm/Cargo.toml`'s
  `[package.metadata.wasm-pack.profile.release]` apply to all linked symbols, including the newly bundled
  Automerge ones (wasm-bodge respects this metadata).

The Rust-side `lib.rs` already does `pub use subduction_wasm::*;` and `pub use automerge_sedimentree_wasm::*;`.
Add `pub use automerge_wasm::*;` (or a more selective re-export if symbol conflicts surface) so wasm-bindgen emits
Automerge's low-level exports as part of this crate's generated JS bindings.

### JavaScript layer

`@automerge/automerge`'s `next` API is implemented in TypeScript on top of the low-level wasm-bindgen exports
from the `automerge-wasm` crate. To preserve that API shape while routing through this package's WASM, **vendor**
the relevant TypeScript source files from upstream `automerge/automerge` `javascript/src/` (at the same rev we
vendored the Rust crate from) into `automerge_subduction_wasm/js/automerge/`:

- `implementation.ts`, `proxies.ts`, `apply_patches.ts`, `low_level.ts`, `numbers.ts`, `counter.ts`,
  `immutable_string.ts`, `internal_state.ts`, `types.ts`, `constants.ts`, `conflicts.ts`, `wasm_types.ts`.

Modify `low_level.ts` so its hard-coded `import { default as initWasm, ... } from "./wasm_bindgen_output/web/..."`
is replaced with a parameter-injected `setWasmApi(api)` function. Each per-target wrapper under
`automerge_subduction_wasm/js/src/{node,web,workerd,bundler,slim}.ts` calls `setWasmApi` against the bodge-produced
shared web-target module at `dist/wasm_bindgen/web/automerge_subduction_wasm.js`. ES module singleton semantics
ensure all entrypoints share one wasm-bindgen instance.

The vendored layer's `UseApi` / `ApiHandler` swap-in pattern stays intact: `initializeWasm` initializes the wasm
module and then calls `UseApi(WasmApi)`; `isWasmInitialized` returns whether `UseApi` has run; `isWasmLoaded`
(workstream 5b addition) returns whether the wasm-bindgen layer has cached a module reference.

A single call to the package's init path initializes both the Automerge and Subduction surfaces because they
share one module instance.

The JS layer exposes the release-only entrypoints `./` / `./slim` / `./wasm` / `./wasm-base64` / `./iife` plus the
new `./automerge.wasm` alias that resolves to the same `.wasm` asset as `./wasm`. The `./debug` family of subpath
exports is dropped (workstream 0).

### Initialization contract

```ts
import init, {
  // Automerge next surface
  init as createDoc,
  load,
  change,
  getHeads,
  // Subduction surface
  Subduction,
  MemorySigner,
} from '@dxos/automerge-subduction';

await init();
```

For Workers:

```ts
import { initFromBase64Wasm } from '@dxos/automerge-subduction/slim';
import { wasmBase64 } from '@dxos/automerge-subduction/wasm-base64';

await initFromBase64Wasm(wasmBase64);
```

`initializeWasm` and `isWasmInitialized` must be re-entrant and idempotent. The existing `set_panic_hook` /
`tracing_setup::init` flow in `automerge_subduction_wasm/src/lib.rs` must continue to work; the Automerge symbols
must not introduce a second `start` function.

## Test Suite

Tests live in `automerge_subduction_wasm/test/` and run via `vitest --run --passWithNoTests`. Tests must import
from the built JS package (`../dist/esm/node.js`), not from Rust internals (`dist/wasm_bindgen/`) or upstream
`@automerge/automerge`. Type-only assertions live in `test/*.test-d.ts` and are run by a separate
`pnpm typecheck` (`tsc --noEmit -p tsconfig.test.json`), not via Vitest's `typecheck` mode.

Required coverage:

1. Import the built JS package from its publish entry (e.g. `dist/esm/node.js`), not from `dist/wasm_bindgen/`
   internals or any other internal artifact.
2. Initialize the WASM module once and assert `isWasmInitialized()` returns true.
3. Create an Automerge document via the re-exported `init`, mutate it via `change`, save via `save`, reload via
   `load`, and verify materialized state.
4. Exercise `loadIncremental`, `saveSince`, and `getHeads`.
5. Exercise the sync APIs end-to-end across two docs:
   `initSyncState` → `generateSyncMessage` → `receiveSyncMessage` →
   `encodeSyncState` / `decodeSyncState` round-trip.
6. Exercise `decodeSyncMessage`, `diff`, `emptyChange`, `stats`, and `RawString`.
7. Instantiate `MemorySigner`, `Subduction`, `SedimentreeId`, `SedimentreeStorage`, `SignedFragment`,
   `SignedLooseCommit`, `CommitWithBlob`, `FragmentWithBlob`, and confirm the existing `SedimentreeAutomerge`
   integration still wraps a document created via the re-exported Automerge `init`.
8. Assert the package output (under `dist/`) contains exactly one production `.wasm` file. The published package
   does not include a debug variant: no `*-debug.wasm`, no `./debug` subpath exports, no `dist/wasm_bindgen/*-debug/`
   directories. The `wasm-debug` Cargo profile remains available for local development but does not ship to npm.
9. Assert the test files and the published package source do not import from `@automerge/automerge`,
   `@automerge/automerge-subduction`, or `@dxos/automerge-subduction` (i.e. upstream imports or self-imports
   leaking back in).
10. Regression test: importing both an Automerge symbol and a Subduction symbol from the package in the same
    process must not instantiate a second WASM module. Verify by snapshotting `WebAssembly.Module` instantiations
    or by checking that `isWasmInitialized()` is true after only one `init()`.

Example shape:

```ts
import { describe, test } from 'vitest';

import init, {
  init as createDoc,
  change,
  getHeads,
  load,
  save,
  MemorySigner,
  Subduction,
  SedimentreeId,
} from '@dxos/automerge-subduction';

describe('@dxos/automerge-subduction unified surface', () => {
  test('one wasm module backs both automerge and subduction', async ({ expect }) => {
    await init();

    let doc = createDoc<{ count: number }>();
    doc = change(doc, (d) => {
      d.count = 1;
    });

    const heads = getHeads(doc);
    expect(heads.length).toBe(1);

    const bytes = save(doc);
    const reloaded = load<{ count: number }>(bytes);
    expect(reloaded.count).toBe(1);

    expect(MemorySigner).toBeDefined();
    expect(Subduction).toBeDefined();
    expect(SedimentreeId).toBeDefined();
  });
});
```

## Memory and Bundle Validation

- The production package must include exactly one `.wasm` file. No debug variant ships.
- A consumer that imports only `@dxos/automerge-subduction` must not pull in
  `@automerge/automerge/dist/*.wasm`. Verify with a bundle-graph assertion in the test suite or in CI.
- The unified-vs-baseline memory benchmark is **out of scope** for this work. We trust the architectural argument
  (one wasm-bindgen module instead of two = less baseline memory) and rely on DXOS Edge's real workload as the
  reference once they migrate.
- Document the live-memory caveat: the unified module reduces duplicated baseline and allows allocator reuse,
  but a single large Automerge operation can still grow the unified linear memory to the Worker limit.

## Acceptance Criteria

- `cd automerge_subduction_wasm && pnpm build` emits exactly one production `.wasm` for the primary export path
  and produces a `dist/` matching the layout described in the implementation plan.
- Importing from `@dxos/automerge-subduction` exposes every symbol listed in
  [Required Automerge Surface](#required-automerge-surface) and
  [Required Subduction Surface](#required-subduction-surface).
- The JS package does not depend on `@automerge/automerge` at runtime.
- `cd automerge_subduction_wasm && pnpm test` runs Node Vitest tests against the built JS package and passes the
  regression test that asserts a single WASM instantiation.
- API names and shapes are close enough that DXOS Edge can swap its low-level Automerge imports with a thin
  compatibility wrapper rather than rewriting replication logic.
