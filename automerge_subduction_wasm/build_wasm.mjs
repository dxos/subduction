#!/usr/bin/env node
// Wraps `wasm-bodge build` so the wasm artifact is built with `panic=unwind`,
// allowing Rust panics in exported functions to surface as `PanicError`
// exceptions at the JS boundary (wasm-bindgen 0.2.118+) instead of aborting
// the WASM module. Aborting in a Cloudflare Workers isolate kills every
// in-flight request — unwinding makes individual panics survivable.
//
// Mechanics (mirrors automerge/automerge#1363):
//   - selects the nightly toolchain (required by `-Zbuild-std`). Two paths:
//       * Nix dev shell exports `WASM_RUST_BIN_DIR` pointing at the
//         flake-provided nightly toolchain's `bin/`. We prepend it to
//         PATH so wasm-bodge's internal `Command::new("cargo")` resolves
//         to the nightly cargo.
//       * Outside the nix shell we fall back to `RUSTUP_TOOLCHAIN`,
//         which rustup honours when picking a toolchain. The default
//         pin matches the flake; CI can override via `WASM_TOOLCHAIN`.
//   - passes `--profile wasm-release` to `wasm-bodge`, which propagates it
//     to `cargo build`. The profile lives in the workspace `Cargo.toml`
//     and overrides `panic = "unwind"` (the `release` profile keeps
//     `abort` so the CLI binary stays small).
//   - `[unstable] build-std = ["std", "panic_unwind"]` in
//     `.cargo/config.toml` makes nightly cargo rebuild std with the unwind
//     panic runtime. Without that, std stays on the prebuilt `panic_abort`
//     variant and `panic = "unwind"` in the profile has no effect.
//
// Local hard requirements (one of):
//   - the nix dev shell (`nix develop`) — provides everything.
//   - rustup with the dated nightly + `rust-src`:
//        rustup toolchain install nightly-2026-04-25 \
//            --profile minimal --component rust-src
//        rustup target add wasm32-unknown-unknown \
//            --toolchain nightly-2026-04-25
//
// CI installs one or the other (.github/workflows/build.yml).

import { spawnSync } from "node:child_process"
import { delimiter, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Pinned dated nightly for reproducible wasm builds. Bump deliberately when
// needed; CI / nix shell can override via the `WASM_TOOLCHAIN` env var.
const WASM_TOOLCHAIN_DEFAULT = "nightly-2026-04-25"

const __filename = fileURLToPath(import.meta.url)
const PKG_ROOT = dirname(__filename)

const args = [
  "build",
  "--crate-path",
  PKG_ROOT,
  "--package-json",
  `${PKG_ROOT}/package.json`,
  "--out-dir",
  `${PKG_ROOT}/dist`,
  "--profile",
  "wasm-release",
]

const env = { ...process.env }

const wasmRustBinDir = env.WASM_RUST_BIN_DIR
if (wasmRustBinDir) {
  env.PATH = `${wasmRustBinDir}${delimiter}${env.PATH ?? ""}`
  console.log(
    `[build_wasm] using nightly toolchain from WASM_RUST_BIN_DIR=${wasmRustBinDir}`,
  )
} else {
  const toolchain = env.WASM_TOOLCHAIN ?? WASM_TOOLCHAIN_DEFAULT
  env.RUSTUP_TOOLCHAIN = toolchain
  console.log(`[build_wasm] using rustup toolchain ${toolchain}`)
}

console.log("[build_wasm] profile=wasm-release")

const result = spawnSync("wasm-bodge", args, { stdio: "inherit", env })

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error(
      "[build_wasm] `wasm-bodge` not found on PATH. Install via the nix devshell or `cargo install --git https://github.com/alexjg/wasm-bodge`.",
    )
  } else {
    console.error(result.error)
  }
  process.exit(1)
}

process.exit(result.status ?? 1)
