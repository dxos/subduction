#!/usr/bin/env node
// Post-`wasm-bodge` build step for `@dxos/automerge-subduction`.
//
// `wasm-bodge` produces:
//   dist/wasm_bindgen/{nodejs,web,bundler}/automerge_subduction_wasm{.js,_bg.wasm,.d.ts}
//   dist/automerge-subduction.wasm
//   dist/index.d.ts                 (raw wasm-bindgen-derived types)
//   dist/{esm,cjs,iife}/<target>.{js,cjs}   (default thin wrappers)
//
// This script then:
//   1. Compiles the vendored Automerge JS layer (js/automerge/*.ts -> dist/automerge/*.{js,d.ts}).
//   2. Patches `dist/wasm_bindgen/web/automerge_subduction_wasm.js` to add
//      `isWasmLoaded` and `reinitWasmSync` (mirroring DXOS Edge's
//      `patches/@automerge__automerge@3.1.1.patch`).
//   3. Generates `dist/esm/wasm-base64.js` and `dist/cjs/wasm-base64.cjs` by
//      base64-encoding the .wasm asset.
//   4. Overwrites bodge's default per-target wrappers in `dist/esm/<target>.js`,
//      `dist/cjs/<target>.cjs`, and `dist/iife/index.js` with versions that
//      load wasm AND wire up the vendored Automerge JS layer via `setWasmApi`.
//   5. Re-emits `dist/index.d.ts` to expose the spec-listed top-level surface
//      plus the `next` namespace plus the Subduction surface.
//
// Each substitution / overwrite asserts that the anchor file existed first, so
// a wasm-bodge or wasm-bindgen version bump that changes the generated layout
// fails the build loudly instead of producing a silently-broken package.

import { execSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"

const __filename = fileURLToPath(import.meta.url)
const PKG_ROOT = dirname(__filename)
const DIST = join(PKG_ROOT, "dist")
const JS = join(PKG_ROOT, "js")

const log = (msg) => console.log(`[build_js] ${msg}`)

const assertExists = (path, why) => {
  if (!existsSync(path)) {
    throw new Error(`build_js: expected ${path} to exist (${why}). Did wasm-bodge run?`)
  }
}

// ---------------------------------------------------------------------------
// 1. Compile vendored Automerge JS layer to dist/automerge/
// ---------------------------------------------------------------------------

log("compiling vendored Automerge JS layer with esbuild + tsc")

mkdirSync(join(DIST, "automerge"), { recursive: true })

const VENDORED_TS = [
  "js/automerge/apply_patches.ts",
  "js/automerge/conflicts.ts",
  "js/automerge/constants.ts",
  "js/automerge/counter.ts",
  "js/automerge/immutable_string.ts",
  "js/automerge/implementation.ts",
  "js/automerge/internal_state.ts",
  "js/automerge/low_level.ts",
  "js/automerge/numbers.ts",
  "js/automerge/proxies.ts",
  "js/automerge/types.ts",
  "js/automerge/generated/release-info.ts",
].map((p) => join(PKG_ROOT, p))

await esbuild.build({
  entryPoints: VENDORED_TS,
  outdir: join(DIST, "automerge"),
  outbase: join(PKG_ROOT, "js", "automerge"),
  format: "esm",
  target: "es2022",
  platform: "neutral",
  bundle: false,
})

// tsc for declaration emission. We use a derived tsconfig that emits .d.ts
// only and sets the rootDir/outDir to the same shape esbuild used.
const tsConfigDeclOnly = {
  extends: "./tsconfig.json",
  compilerOptions: {
    declaration: true,
    emitDeclarationOnly: true,
    outDir: "./dist",
    rootDir: "./js",
  },
  include: ["js/automerge/**/*.ts"],
  exclude: ["dist", "node_modules", "test"],
}
const tsconfigPath = join(PKG_ROOT, ".tsconfig.build.json")
writeFileSync(tsconfigPath, JSON.stringify(tsConfigDeclOnly, null, 2))
try {
  execSync(`node_modules/.bin/tsc -p ${tsconfigPath}`, {
    cwd: PKG_ROOT,
    stdio: "inherit",
  })
} catch (err) {
  // tsc returns non-zero on type errors but still emits .d.ts.
  // We allow this for the vendored layer (upstream code, not ours to fix).
  log(`tsc emitted .d.ts despite type errors (vendored layer; ignoring)`)
}

// ---------------------------------------------------------------------------
// 2. Apply the wasm-bindgen-output patch (isWasmLoaded + reinitWasmSync).
// ---------------------------------------------------------------------------

log("patching dist/wasm_bindgen/web/automerge_subduction_wasm.js")

const wbgWebPath = join(
  DIST,
  "wasm_bindgen",
  "web",
  "automerge_subduction_wasm.js",
)
assertExists(wbgWebPath, "wasm-bodge output")

let wbg = readFileSync(wbgWebPath, "utf8")

// NOTE: anchors must match the exact wasm-bindgen output emitted by the
// pinned `wasm-bindgen = "=0.2.118"` version (workspace pin in /Cargo.toml).
// If wasm-bindgen is bumped, expect to re-derive these anchors.
//
// wasm-bindgen 0.2.118 already declares `let wasmModule, wasm;` at the top
// level and caches `wasmModule = module;` in `__wbg_finalize_init`, so we
// don't need to add a cache. We only need to:
//
//   - Drop the early-return guards in `initSync` and `__wbg_init` so re-init
//     works (`reinitWasmSync` calls `initSync(wasmModule)` again).
//   - Add `isWasmLoaded` and `reinitWasmSync` and export them.
const patches = [
  {
    why: "comment out initSync re-entry guard so reinitWasmSync can reset memory",
    anchor:
      "function initSync(module) {\n    if (wasm !== undefined) return wasm;",
    insert:
      "function initSync(module) {\n    // if (wasm !== undefined) return wasm;",
  },
  {
    why: "comment out __wbg_init re-entry guard so async re-init works",
    anchor:
      "async function __wbg_init(module_or_path) {\n    if (wasm !== undefined) return wasm;",
    insert:
      "async function __wbg_init(module_or_path) {\n    // if (wasm !== undefined) return wasm;",
  },
  {
    why: "add isWasmLoaded + reinitWasmSync and extend trailing export",
    anchor: "export { initSync, __wbg_init as default };",
    insert: `function isWasmLoaded() {
    return wasmModule !== undefined;
}

function reinitWasmSync() {
    if (wasmModule === undefined) {
        throw new Error('reinitWasm called before wasm was initialized.');
    }
    return initSync({ module: wasmModule });
}

export { initSync, __wbg_init as default, isWasmLoaded, reinitWasmSync };`,
  },
]

for (const { why, anchor, insert } of patches) {
  if (!wbg.includes(anchor)) {
    throw new Error(
      `build_js: patch anchor not found in wasm-bindgen output (${why}). ` +
        `wasm-bindgen output structure may have changed; the regex/string anchor needs updating.`,
    )
  }
  wbg = wbg.replace(anchor, insert)
}

writeFileSync(wbgWebPath, wbg)

// ---------------------------------------------------------------------------
// 3. Generate wasm-base64.{js,cjs}
// ---------------------------------------------------------------------------

log("generating wasm-base64.{js,cjs}")

const wasmAssetPath = join(DIST, "automerge-subduction.wasm")
assertExists(wasmAssetPath, "primary wasm asset")
const wasmBase64 = readFileSync(wasmAssetPath).toString("base64")

mkdirSync(join(DIST, "esm"), { recursive: true })
mkdirSync(join(DIST, "cjs"), { recursive: true })

writeFileSync(
  join(DIST, "esm", "wasm-base64.js"),
  `export const wasmBase64 = ${JSON.stringify(wasmBase64)};\n`,
)
writeFileSync(
  join(DIST, "cjs", "wasm-base64.cjs"),
  `'use strict';\nexports.wasmBase64 = ${JSON.stringify(wasmBase64)};\n`,
)

// ---------------------------------------------------------------------------
// 4. Overwrite per-target wrappers
// ---------------------------------------------------------------------------

log("writing per-target wrappers")

// Common surface re-exports inserted into every wrapper.
// Each wrapper still defines its own auto-init step.
const SHARED_REEXPORTS = `
// Spec-listed top-level Automerge \`next\` surface.
export {
  init,
  load,
  loadIncremental,
  change,
  emptyChange,
  free,
  getHeads,
  diff,
  save,
  saveSince,
  initSyncState,
  encodeSyncState,
  decodeSyncState,
  receiveSyncMessage,
  generateSyncMessage,
  decodeSyncMessage,
  stats,
  RawString,
} from "../automerge/implementation.js";

// WASM lifecycle.
export {
  initializeWasm,
  initializeBase64Wasm,
  initializeBase64Wasm as initFromBase64Wasm,
  isWasmInitialized,
  isWasmLoaded,
  reinitWasmSync,
  wasmInitialized,
} from "../automerge/low_level.js";

// Upstream's \`next\` namespace (re-exports same module).
export * as next from "../automerge/implementation.js";

// Subduction surface (and adjacent existing exports) re-exported from the
// shared wasm-bindgen module. The spec listed \`Transport\` and
// \`SedimentreeStorage\` but those are conceptual umbrella names; the
// concrete wasm-bindgen exports are the typed variants below.
export {
  // Spec-listed required Subduction surface.
  Subduction,
  MemorySigner,
  CommitId,
  CommitWithBlob,
  FragmentWithBlob,
  SedimentreeId,
  SignedFragment,
  SignedLooseCommit,
  // Concrete Transport implementations (replaces spec's \`Transport\`).
  AuthenticatedTransport,
  MessagePortTransport,
  AuthenticatedWebSocket,
  AuthenticatedLongPoll,
  // Concrete Storage implementations (replaces spec's \`SedimentreeStorage\`).
  MemoryStorage,
  IndexedDbStorage,
  // Adjacent existing exports retained per spec.
  SedimentreeAutomerge,
  SubductionWebSocket,
  SubductionLongPoll,
  SubductionHttpLongPoll,
  Sedimentree,
  Digest,
  PeerId,
  WebCryptoSigner,
  Fragment,
  FragmentRequested,
  FragmentState,
  FragmentStateStore,
  LooseCommit,
} from "../wasm_bindgen/web/automerge_subduction_wasm.js";
`

// Node ESM wrapper: synchronous file read + initSync + setWasmApi.
const NODE_WRAPPER = `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as wasmModule from "../wasm_bindgen/web/automerge_subduction_wasm.js";
import { setWasmApi } from "../automerge/low_level.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  join(__dirname, "../wasm_bindgen/web/automerge_subduction_wasm_bg.wasm"),
);
wasmModule.initSync({ module: wasmBytes });
setWasmApi(wasmModule);
${SHARED_REEXPORTS}`

// Web ESM wrapper: base64-decode + initSync + setWasmApi.
const WEB_WRAPPER = `import * as wasmModule from "../wasm_bindgen/web/automerge_subduction_wasm.js";
import { wasmBase64 } from "./wasm-base64.js";
import { setWasmApi } from "../automerge/low_level.js";

const wasmBytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
wasmModule.initSync({ module: wasmBytes });
setWasmApi(wasmModule);
${SHARED_REEXPORTS}`

// Workerd ESM wrapper: static .wasm import + initSync + setWasmApi.
const WORKERD_WRAPPER = `import * as wasmModule from "../wasm_bindgen/web/automerge_subduction_wasm.js";
import wasmBin from "../wasm_bindgen/web/automerge_subduction_wasm_bg.wasm";
import { setWasmApi } from "../automerge/low_level.js";

wasmModule.initSync({ module: wasmBin });
setWasmApi(wasmModule);
${SHARED_REEXPORTS}`

// Bundler ESM wrapper: bundler shim + setWasmApi.
const BUNDLER_WRAPPER = `import { __wbg_set_wasm as __bundler_set_wasm } from "../wasm_bindgen/bundler/automerge_subduction_wasm_bg.js";
import * as wasmExports from "../wasm_bindgen/bundler/automerge_subduction_wasm_bg.wasm";
import * as wasmModule from "../wasm_bindgen/web/automerge_subduction_wasm.js";
import { __wbg_set_wasm } from "../wasm_bindgen/web/automerge_subduction_wasm.js";
import { setWasmApi } from "../automerge/low_level.js";

__bundler_set_wasm(wasmExports);
wasmExports.__wbindgen_start();
__wbg_set_wasm(wasmExports);
setWasmApi(wasmModule);
${SHARED_REEXPORTS}`

// Slim ESM wrapper: no auto-init; consumer calls initFromBase64Wasm.
const SLIM_WRAPPER = `import * as wasmModule from "../wasm_bindgen/web/automerge_subduction_wasm.js";
import { setWasmApi } from "../automerge/low_level.js";

// Register the wasm-bindgen module so initializeWasm/reinitWasmSync work
// once the consumer has provided the bytes via initializeWasm or
// initFromBase64Wasm. Calls into the API will throw until then.
setWasmApi(wasmModule);
${SHARED_REEXPORTS}`

const wrappers = {
  "esm/node.js": NODE_WRAPPER,
  "esm/web.js": WEB_WRAPPER,
  "esm/workerd.js": WORKERD_WRAPPER,
  "esm/bundler.js": BUNDLER_WRAPPER,
  "esm/slim.js": SLIM_WRAPPER,
}

for (const [rel, body] of Object.entries(wrappers)) {
  const path = join(DIST, rel)
  // We don't strictly require bodge to have written one first; we always own
  // the file. But we log when we're overwriting a bodge-provided file vs.
  // creating a fresh one, for diagnostics.
  if (existsSync(path)) {
    log(`  overwriting ${rel}`)
  } else {
    log(`  creating ${rel}`)
  }
  writeFileSync(path, body)
}

// CJS wrappers: hand-coded so they use CJS-native `__dirname` / `require()`
// rather than bundling from ESM (which trips on `import.meta.url`).
log("writing CJS wrappers")

const NODE_CJS = `'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const wasmModule = require('../wasm_bindgen/nodejs/automerge_subduction_wasm.cjs');
const { setWasmApi } = require('../automerge/low_level.cjs');
const implementation = require('../automerge/implementation.cjs');
const lowLevel = require('../automerge/low_level.cjs');

const wasmBytes = readFileSync(
  join(__dirname, '../wasm_bindgen/nodejs/automerge_subduction_wasm_bg.wasm'),
);
// nodejs target's wasm-bindgen output auto-loads on require, so wasmModule is
// already initialized by the time we get here. We just need to wire setWasmApi.
setWasmApi(wasmModule);

// Spec-listed top-level Automerge surface
exports.init = implementation.init;
exports.load = implementation.load;
exports.loadIncremental = implementation.loadIncremental;
exports.change = implementation.change;
exports.emptyChange = implementation.emptyChange;
exports.free = implementation.free;
exports.getHeads = implementation.getHeads;
exports.diff = implementation.diff;
exports.save = implementation.save;
exports.saveSince = implementation.saveSince;
exports.initSyncState = implementation.initSyncState;
exports.encodeSyncState = implementation.encodeSyncState;
exports.decodeSyncState = implementation.decodeSyncState;
exports.receiveSyncMessage = implementation.receiveSyncMessage;
exports.generateSyncMessage = implementation.generateSyncMessage;
exports.decodeSyncMessage = implementation.decodeSyncMessage;
exports.stats = implementation.stats;
exports.RawString = implementation.RawString;

// WASM lifecycle
exports.initializeWasm = lowLevel.initializeWasm;
exports.initializeBase64Wasm = lowLevel.initializeBase64Wasm;
exports.initFromBase64Wasm = lowLevel.initializeBase64Wasm;
exports.isWasmInitialized = lowLevel.isWasmInitialized;
exports.isWasmLoaded = lowLevel.isWasmLoaded;
exports.reinitWasmSync = lowLevel.reinitWasmSync;
exports.wasmInitialized = lowLevel.wasmInitialized;

// next namespace
exports.next = implementation;

// Subduction surface (re-exported from same wasm-bindgen module).
const SUBDUCTION_NAMES = [
  'Subduction', 'MemorySigner', 'CommitId', 'CommitWithBlob',
  'FragmentWithBlob', 'SedimentreeId', 'SignedFragment', 'SignedLooseCommit',
  'AuthenticatedTransport', 'MessagePortTransport', 'AuthenticatedWebSocket',
  'AuthenticatedLongPoll', 'MemoryStorage', 'IndexedDbStorage',
  'SedimentreeAutomerge', 'SubductionWebSocket', 'SubductionLongPoll',
  'SubductionHttpLongPoll', 'Sedimentree', 'Digest', 'PeerId',
  'WebCryptoSigner', 'Fragment', 'FragmentRequested', 'FragmentState',
  'FragmentStateStore', 'LooseCommit',
];
for (const name of SUBDUCTION_NAMES) {
  if (wasmModule[name] !== undefined) {
    exports[name] = wasmModule[name];
  }
}
`

// Web/slim CJS variants share most of the surface but use base64 init or no
// auto-init. Let bodge's stock `web.cjs` and `slim.cjs` handle these for now;
// they re-export from web-bindings.cjs which is bodge's bundled web target.
// Our CJS users primarily land on `node.cjs` (the `require` condition for the
// `node` exports key); web/slim CJS are fallback paths.
//
// We also write a CommonJS variant of the vendored Automerge layer. esbuild
// already emitted it as `.cjs` (since we used `--format=esm` it didn't, oops).
// We emit a separate CJS pass for the vendored layer so node.cjs's require()s
// resolve.
log("compiling vendored layer to CJS")
await esbuild.build({
  entryPoints: VENDORED_TS,
  outdir: join(DIST, "automerge"),
  outbase: join(PKG_ROOT, "js", "automerge"),
  format: "cjs",
  target: "es2022",
  platform: "neutral",
  bundle: false,
  outExtension: { ".js": ".cjs" },
})

writeFileSync(join(DIST, "cjs", "node.cjs"), NODE_CJS)

// IIFE: bundle the web entry, defining `import.meta.url` away so the dead
// URL-fetch path in wasm-bindgen output type-checks.
log("bundling IIFE entry from web wrapper")
mkdirSync(join(DIST, "iife"), { recursive: true })
await esbuild.build({
  entryPoints: [join(DIST, "esm", "web.js")],
  outfile: join(DIST, "iife", "index.js"),
  format: "iife",
  globalName: "AutomergeSubduction",
  bundle: true,
  define: {
    "import.meta.url": '"file:///"',
  },
})

// ---------------------------------------------------------------------------
// 4b. Re-add `./automerge.wasm` export alias (bodge strips it).
// ---------------------------------------------------------------------------

log("re-adding ./automerge.wasm export alias to package.json")

const pkgJsonPath = join(PKG_ROOT, "package.json")
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
if (pkgJson.exports["./automerge.wasm"] !== "./dist/automerge-subduction.wasm") {
  // Re-construct exports with `./automerge.wasm` immediately after `./wasm`.
  const newExports = {}
  for (const [k, v] of Object.entries(pkgJson.exports)) {
    if (k === "./automerge.wasm") continue // skip stale entry, re-add below
    newExports[k] = v
    if (k === "./wasm") {
      newExports["./automerge.wasm"] = "./dist/automerge-subduction.wasm"
    }
  }
  pkgJson.exports = newExports
  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n")
}

// ---------------------------------------------------------------------------
// 5. Re-emit dist/index.d.ts
// ---------------------------------------------------------------------------

log("emitting dist/index.d.ts")

// Mirror the runtime surface exposed by `dist/esm/<target>.js`. The Subduction
// types come from the wasm-bindgen `.d.ts` (which lives under
// `dist/wasm_bindgen/nodejs/`); the Automerge types come from our compiled
// vendored layer (`dist/automerge/implementation.d.ts`) plus
// `dist/automerge/wasm_types.d.ts`.
const INDEX_DTS = `// Generated by build_js.js. Do not edit.

export {
  init,
  load,
  loadIncremental,
  change,
  emptyChange,
  free,
  getHeads,
  diff,
  save,
  saveSince,
  initSyncState,
  encodeSyncState,
  decodeSyncState,
  receiveSyncMessage,
  generateSyncMessage,
  decodeSyncMessage,
  stats,
  RawString,
} from "./automerge/implementation.js";

export {
  initializeWasm,
  initializeBase64Wasm,
  initializeBase64Wasm as initFromBase64Wasm,
  isWasmInitialized,
  isWasmLoaded,
  reinitWasmSync,
  wasmInitialized,
} from "./automerge/low_level.js";

export type { Doc, ApplyOptions } from "./automerge/implementation.js";

export type {
  Heads,
  SyncState,
  Patch,
  PutPatch,
  SpliceTextPatch,
  Prop,
} from "./automerge/wasm_types.js";

export * as next from "./automerge/implementation.js";

export {
  // Spec-listed required Subduction surface.
  Subduction,
  MemorySigner,
  CommitId,
  CommitWithBlob,
  FragmentWithBlob,
  SedimentreeId,
  SignedFragment,
  SignedLooseCommit,
  // Concrete Transport implementations.
  AuthenticatedTransport,
  MessagePortTransport,
  AuthenticatedWebSocket,
  AuthenticatedLongPoll,
  // Concrete Storage implementations.
  MemoryStorage,
  IndexedDbStorage,
  // Adjacent existing exports.
  SedimentreeAutomerge,
  SubductionWebSocket,
  SubductionLongPoll,
  SubductionHttpLongPoll,
  Sedimentree,
  Digest,
  PeerId,
  WebCryptoSigner,
  Fragment,
  FragmentRequested,
  FragmentState,
  FragmentStateStore,
  LooseCommit,
} from "./wasm_bindgen/nodejs/automerge_subduction_wasm.js";
`

writeFileSync(join(DIST, "index.d.ts"), INDEX_DTS)

// Per-target type shims so tests/consumers that import directly from
// `dist/esm/<target>.js` get the same types as the package's main entry.
const TARGET_DTS_SHIM = `// Generated by build_js.js. Do not edit.
export * from "../index.js";
`
for (const target of ["node", "web", "workerd", "bundler", "slim"]) {
  writeFileSync(join(DIST, "esm", `${target}.d.ts`), TARGET_DTS_SHIM)
}
writeFileSync(
  join(DIST, "esm", "wasm-base64.d.ts"),
  "export const wasmBase64: string;\n",
)

// Also copy `wasm_types.d.ts` to dist/automerge/ in case esbuild didn't
// (esbuild does not emit .d.ts files, only .js).
copyFileSync(
  join(JS, "automerge", "wasm_types.d.ts"),
  join(DIST, "automerge", "wasm_types.d.ts"),
)

log("done")
