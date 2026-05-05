// Upstream's build script generates this file at npm-publish time with the
// git SHA of the published commit. For our package, the equivalent provenance
// lives in:
// - `automerge_subduction_wasm/Cargo.toml` (workspace `automerge` version)
// - `crates/automerge_wasm/VENDOR.md` (vendored upstream rev)
// - the package's own `version` in `package.json`
//
// `JS_GIT_HEAD` is referenced by `implementation.ts` but is not part of the
// public API. We export the upstream rev we vendored from so consumers
// inspecting `.next.JS_GIT_HEAD` see a meaningful value.
export const JS_GIT_HEAD = "8246d0f8218cd49dc1af56ba6eefd88ed215665c"
