/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Modified from upstream `@automerge/automerge`'s `low_level.ts`. The upstream
// file hard-imports the wasm-bindgen output via:
//
//   import { default as initWasm } from "./wasm_bindgen_output/web/automerge_wasm.js"
//   import * as WasmApi from "./wasm_bindgen_output/web/automerge_wasm.js"
//
// In this package the wasm-bindgen output lives at a path that's only known to
// each per-target entrypoint (e.g. `dist/wasm_bindgen/web/automerge_subduction_wasm.js`)
// and is shared across all entrypoints via the wasm-bodge "shared web target"
// architecture. Each per-target wrapper imports its wasm-bindgen module and calls
// `setWasmApi(...)` here to register it.
//
// `setWasmApi` doubles as `UseApi` (kept exported for compat with vendored
// `implementation.ts` which still calls `UseApi`).

import type {
  API,
  Automerge,
  Change,
  DecodedChange,
  SyncMessage,
  SyncState,
  JsSyncState,
  DecodedSyncMessage,
  ChangeToEncode,
  LoadOptions,
  InitOptions,
  DecodedBundle,
  WasmReleaseInfo,
} from "./wasm_types.js"
export type { ChangeToEncode } from "./wasm_types.js"

// The shape of the wasm-bindgen output module after our build's `build_js.js`
// post-build patch (workstream 5b): same as upstream's `--target web` shape
// plus the two new exports `isWasmLoaded` and `reinitWasmSync`, plus a
// caller-changed `initSync` that caches the loaded module so `reinitWasmSync`
// can re-instantiate.
interface WasmBindgenModule extends API {
  default: (init: { module_or_path: unknown }) => Promise<WebAssembly.Instance>
  initSync: (module: unknown) => unknown
  isWasmLoaded: () => boolean
  reinitWasmSync: () => unknown
}

let _initialized = false
let _initializeListeners: (() => void)[] = []

// The most recently registered wasm-bindgen module. Set by per-target
// wrappers via `setWasmApi`. Kept so `initializeWasm`, `isWasmLoaded`, and
// `reinitWasmSync` can delegate to it after the wrapper has run.
let _wasmModule: WasmBindgenModule | null = null

/**
 * Register the wasm-bindgen module produced by the per-target wrapper.
 *
 * Called by every per-target entrypoint (`node.ts`, `web.ts`, `workerd.ts`,
 * `bundler.ts`, `slim.ts`) after the wrapper has loaded/initialized the wasm
 * binary using its environment-specific mechanism. After this call, every
 * `ApiHandler` method is wired to the real wasm-bindgen implementation and
 * the package is fully functional.
 *
 * Also kept exported under the legacy name `UseApi` for compatibility with
 * the vendored `implementation.ts`, which calls `UseApi(WasmApi)` directly.
 */
export function setWasmApi(api: WasmBindgenModule): void {
  _wasmModule = api
  for (const k in api) {
    ;(ApiHandler as any)[k] = (api as any)[k]
  }
  _initialized = true
  for (const listener of _initializeListeners) {
    listener()
  }
}

/** @deprecated Use {@link setWasmApi}. Retained for vendored callers. */
export function UseApi(api: API): void {
  setWasmApi(api as WasmBindgenModule)
}

/* eslint-disable */
export const ApiHandler: API = {
  create(options?: InitOptions): Automerge {
    throw new RangeError("Automerge.use() not called")
  },
  load(data: Uint8Array, options?: LoadOptions): Automerge {
    throw new RangeError("Automerge.use() not called (load)")
  },
  encodeChange(change: ChangeToEncode): Change {
    throw new RangeError("Automerge.use() not called (encodeChange)")
  },
  decodeChange(change: Change): DecodedChange {
    throw new RangeError("Automerge.use() not called (decodeChange)")
  },
  initSyncState(): SyncState {
    throw new RangeError("Automerge.use() not called (initSyncState)")
  },
  encodeSyncMessage(message: DecodedSyncMessage): SyncMessage {
    throw new RangeError("Automerge.use() not called (encodeSyncMessage)")
  },
  decodeSyncMessage(msg: SyncMessage): DecodedSyncMessage {
    throw new RangeError("Automerge.use() not called (decodeSyncMessage)")
  },
  encodeSyncState(state: SyncState): Uint8Array {
    throw new RangeError("Automerge.use() not called (encodeSyncState)")
  },
  decodeSyncState(data: Uint8Array): SyncState {
    throw new RangeError("Automerge.use() not called (decodeSyncState)")
  },
  exportSyncState(state: SyncState): JsSyncState {
    throw new RangeError("Automerge.use() not called (exportSyncState)")
  },
  importSyncState(state: JsSyncState): SyncState {
    throw new RangeError("Automerge.use() not called (importSyncState)")
  },
  readBundle(data: Uint8Array): DecodedBundle {
    throw new RangeError("Automerge.use() not called (readBundle)")
  },
  wasmReleaseInfo(): WasmReleaseInfo {
    throw new RangeError("Automerge.use() not called (wasmReleaseInfo)")
  },
}
/* eslint-enable */

/**
 * Initialize the wasm module asynchronously.
 *
 * The argument is forwarded to the wasm-bindgen `__wbg_init` default export
 * (`Uint8Array | Request | Promise<Uint8Array> | string`; if a string it is
 * fetched as a URL).
 *
 * The promise resolves with the instantiated `WebAssembly.Instance` so callers
 * can pass it to other tooling.
 *
 * @remarks
 * - The vendored layer relies on a per-target wrapper having called
 *   {@link setWasmApi} first to register the wasm-bindgen module.
 * - `initializeWasm` was modified from upstream (`Promise<void>`) to return
 *   the instance, matching the patch in
 *   `dxos/edge` `patches/@automerge__automerge@3.1.1.patch`.
 */
export function initializeWasm(
  wasmBlob: Uint8Array | Request | Promise<Uint8Array> | string,
): Promise<WebAssembly.Instance> {
  if (_wasmModule === null) {
    throw new Error(
      "initializeWasm called before any per-target entrypoint registered the wasm-bindgen module via setWasmApi",
    )
  }
  const initFn = _wasmModule.default
  return initFn({ module_or_path: wasmBlob }).then((instance) => {
    if (_wasmModule !== null) {
      setWasmApi(_wasmModule)
    }
    return instance
  })
}

/** Initialize the wasm module from a base64-encoded string. */
export function initializeBase64Wasm(
  wasmBase64: string,
): Promise<WebAssembly.Instance> {
  return initializeWasm(
    Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0)),
  )
}

/**
 * A promise which resolves when the WebAssembly module has been initialized
 * (or immediately if it has already been initialized).
 */
export function wasmInitialized(): Promise<void> {
  if (_initialized) return Promise.resolve()
  return new Promise((resolve) => {
    _initializeListeners.push(resolve)
  })
}

/**
 * Whether `setWasmApi` has been called and the wasm-bindgen API is wired up.
 *
 * Distinct from {@link isWasmLoaded}: a module can be loaded by the
 * wasm-bindgen layer (i.e. `initSync`/`__wbg_init` has cached a module
 * reference) but not yet swapped into the `ApiHandler` table.
 */
export function isWasmInitialized(): boolean {
  return _initialized
}

/**
 * Whether the wasm-bindgen layer has cached a `WebAssembly.Module` reference.
 *
 * Forwarded to the wasm-bindgen output's `isWasmLoaded` (added by the
 * `build_js.js` post-build patch in workstream 5b).
 */
export function isWasmLoaded(): boolean {
  return _wasmModule !== null && _wasmModule.isWasmLoaded()
}

/**
 * Synchronously re-instantiate the cached wasm module to reset linear memory.
 *
 * Throws if no module has been loaded yet (matches the patch's exact message).
 * Forwarded to the wasm-bindgen output's `reinitWasmSync` (added by the
 * `build_js.js` post-build patch in workstream 5b).
 */
export function reinitWasmSync(): unknown {
  if (_wasmModule === null) {
    throw new Error("reinitWasm called before wasm was initialized.")
  }
  return _wasmModule.reinitWasmSync()
}
