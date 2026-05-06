//! # Wasm Bindings for the Subduction/Automerge integration.
//!
//! This crate re-exports all types from `subduction_wasm` and `automerge_sedimentree_wasm`
//! to provide a single unified entry point for TypeScript/JavaScript consumers.
//!
//! ## Log Level Configuration
//!
//! The default log level is `warn`. You can change it at runtime or configure
//! it to be read at startup:
//!
//! ### Live adjustment (no reload required)
//!
//! ```js
//! // From the browser console or application code:
//! wasm.setSubductionLogLevel("debug")
//! ```
//!
//! ### Persistent configuration
//!
//! **Browser:** Set `SUBDUCTION_LOG_LEVEL` in `localStorage`:
//!
//! ```js
//! localStorage.setItem("SUBDUCTION_LOG_LEVEL", "debug")
//! // Takes effect on next page load
//! ```
//!
//! **Node.js:** Set the `SUBDUCTION_LOG_LEVEL` environment variable:
//!
//! ```sh
//! SUBDUCTION_LOG_LEVEL=debug node your-app.js
//! ```
//!
//! Valid levels: `trace`, `debug`, `info`, `warn`, `error`, `off`

#![cfg_attr(not(feature = "std"), no_std)]
#![cfg_attr(docsrs, feature(doc_cfg))]
#![allow(clippy::missing_const_for_fn)] // wasm_bindgen doens't like const
#![allow(ambiguous_glob_reexports)] // Intentional: umbrella crate for JS consumers

#[cfg(feature = "std")]
extern crate std;

extern crate alloc;

use alloc::string::String;

pub mod js_logger;

// Re-export everything from automerge_wasm, subduction_wasm, and automerge_sedimentree_wasm.
// All three contribute their `#[wasm_bindgen]` symbols to this crate's single cdylib so
// downstream consumers see one unified surface from one shared `.wasm` linear memory.
pub use automerge_sedimentree_wasm::*;
pub use automerge_wasm::*;
pub use subduction_wasm::*;

use wasm_bindgen::prelude::*;

/// The key used for reading/writing the log level in `localStorage` (browser)
/// or `process.env` (Node.js).
const LOG_LEVEL_KEY: &str = "SUBDUCTION_LOG_LEVEL";

// ---------------------------------------------------------------------------
// JS interop for reading/writing log level from the environment
// ---------------------------------------------------------------------------

/// Try to read `SUBDUCTION_LOG_LEVEL` from the environment.
///
/// Checks (in order):
/// 1. `globalThis.localStorage.getItem("SUBDUCTION_LOG_LEVEL")` (browser)
/// 2. `globalThis.process.env.SUBDUCTION_LOG_LEVEL` (Node.js)
fn read_log_level_from_env() -> Option<String> {
    read_from_local_storage().or_else(read_from_process_env)
}

fn read_from_local_storage() -> Option<String> {
    let global = js_sys::global();

    let storage = js_sys::Reflect::get(&global, &JsValue::from_str("localStorage")).ok()?;
    if storage.is_undefined() || storage.is_null() {
        return None;
    }

    let get_item = js_sys::Reflect::get(&storage, &JsValue::from_str("getItem")).ok()?;
    let get_item = get_item.dyn_ref::<js_sys::Function>()?;

    let result = get_item
        .call1(&storage, &JsValue::from_str(LOG_LEVEL_KEY))
        .ok()?;

    result.as_string()
}

fn write_to_local_storage(level: &str) {
    let Ok(storage) = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("localStorage"))
    else {
        return;
    };

    if storage.is_undefined() || storage.is_null() {
        return;
    }

    let Ok(set_item) = js_sys::Reflect::get(&storage, &JsValue::from_str("setItem")) else {
        return;
    };

    let Some(set_item) = set_item.dyn_ref::<js_sys::Function>() else {
        return;
    };

    drop(set_item.call2(
        &storage,
        &JsValue::from_str(LOG_LEVEL_KEY),
        &JsValue::from_str(level),
    ));
}

fn read_from_process_env() -> Option<String> {
    let global = js_sys::global();

    let process = js_sys::Reflect::get(&global, &JsValue::from_str("process")).ok()?;
    if process.is_undefined() || process.is_null() {
        return None;
    }

    let env = js_sys::Reflect::get(&process, &JsValue::from_str("env")).ok()?;
    if env.is_undefined() || env.is_null() {
        return None;
    }

    let val = js_sys::Reflect::get(&env, &JsValue::from_str(LOG_LEVEL_KEY)).ok()?;
    val.as_string()
}

// ---------------------------------------------------------------------------
// Tracing setup with reloadable filter
// ---------------------------------------------------------------------------

#[cfg(feature = "wasm-tracing")]
mod tracing_setup {
    use std::sync::OnceLock;

    use tracing_subscriber::{
        Registry, filter::LevelFilter, layer::SubscriberExt, reload, util::SubscriberInitExt,
    };
    use wasm_tracing::{WasmLayer, WasmLayerConfig};

    use crate::js_logger::JsCallbackLayer;

    /// Global handle for dynamically reloading the log level filter.
    static RELOAD_HANDLE: OnceLock<reload::Handle<LevelFilter, Registry>> = OnceLock::new();

    pub(crate) fn init(initial_level: LevelFilter) {
        // WasmLayer accepts everything; the reloadable LevelFilter controls
        // what passes through.
        let mut config = WasmLayerConfig::new().with_max_level(tracing::Level::TRACE);
        config.use_console_methods = true;

        let wasm_layer = WasmLayer::new(config);
        let js_callback_layer = JsCallbackLayer;
        let (filter, reload_handle) = reload::Layer::new(initial_level);

        tracing_subscriber::registry()
            .with(filter)
            .with(wasm_layer)
            .with(js_callback_layer)
            .init();

        RELOAD_HANDLE.set(reload_handle).ok();
    }

    pub(crate) fn set_level(
        level: LevelFilter,
    ) -> Result<(), std::boxed::Box<dyn std::error::Error + Send + Sync>> {
        let handle = RELOAD_HANDLE.get().ok_or("tracing not initialized")?;
        handle.modify(|filter| *filter = level)?;
        Ok(())
    }
}

#[cfg(not(feature = "wasm-tracing"))]
mod tracing_setup {
    use std::sync::OnceLock;

    use tracing_subscriber::{
        Registry, filter::LevelFilter, layer::SubscriberExt, reload, util::SubscriberInitExt,
    };

    use crate::js_logger::JsCallbackLayer;

    /// Global handle for dynamically reloading the log level filter.
    static RELOAD_HANDLE: OnceLock<reload::Handle<LevelFilter, Registry>> = OnceLock::new();

    pub(crate) fn init(initial_level: LevelFilter) {
        // Initialize only the JS callback layer and filter when wasm-tracing is disabled
        let js_callback_layer = JsCallbackLayer;
        let (filter, reload_handle) = reload::Layer::new(initial_level);

        tracing_subscriber::registry()
            .with(filter)
            .with(js_callback_layer)
            .init();

        RELOAD_HANDLE.set(reload_handle).ok();
    }

    pub(crate) fn set_level(
        level: LevelFilter,
    ) -> Result<(), std::boxed::Box<dyn std::error::Error + Send + Sync>> {
        let handle = RELOAD_HANDLE.get().ok_or("tracing not initialized")?;
        handle.modify(|filter| *filter = level)?;
        Ok(())
    }
}

fn parse_level_filter(s: &str) -> Option<tracing_subscriber::filter::LevelFilter> {
    match s.to_ascii_lowercase().as_str() {
        "trace" => Some(tracing_subscriber::filter::LevelFilter::TRACE),
        "debug" => Some(tracing_subscriber::filter::LevelFilter::DEBUG),
        "info" => Some(tracing_subscriber::filter::LevelFilter::INFO),
        "warn" => Some(tracing_subscriber::filter::LevelFilter::WARN),
        "error" => Some(tracing_subscriber::filter::LevelFilter::ERROR),
        "off" => Some(tracing_subscriber::filter::LevelFilter::OFF),
        _ => None,
    }
}

fn level_filter_name(level: tracing_subscriber::filter::LevelFilter) -> &'static str {
    if level == tracing_subscriber::filter::LevelFilter::TRACE {
        "trace"
    } else if level == tracing_subscriber::filter::LevelFilter::DEBUG {
        "debug"
    } else if level == tracing_subscriber::filter::LevelFilter::INFO {
        "info"
    } else if level == tracing_subscriber::filter::LevelFilter::WARN {
        "warn"
    } else if level == tracing_subscriber::filter::LevelFilter::ERROR {
        "error"
    } else {
        "off"
    }
}

/// Set the log level at runtime.
///
/// Valid levels: `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"off"`
///
/// The new level takes effect immediately and is persisted to `localStorage`
/// (browser) so it survives page reloads.
///
/// # Errors
///
/// Returns an error if the level string is invalid or if tracing has not
/// been initialized.
///
/// # Example
///
/// ```js
/// // From the browser console:
/// wasm.setSubductionLogLevel("debug")
///
/// // Restore default:
/// wasm.setSubductionLogLevel("warn")
/// ```
#[wasm_bindgen(js_name = setSubductionLogLevel)]
pub fn set_subduction_log_level(level: &str) -> Result<(), JsValue> {
    let level_filter = parse_level_filter(level).ok_or_else(|| {
        JsValue::from_str("invalid log level: expected one of trace, debug, info, warn, error, off")
    })?;

    tracing_setup::set_level(level_filter)
        .map_err(|e| JsValue::from_str(&alloc::format!("failed to set log level: {e}")))?;

    // Persist to localStorage so the level survives page reloads
    write_to_local_storage(level_filter_name(level_filter));

    Ok(())
}

/// Initialize tracing infrastructure with the JS callback layer.
///
/// Historically also installed `console_error_panic_hook`. That hook was
/// removed deliberately, not just as redundant cleanup: with the
/// `panic=unwind` build, Rust panics surface as `PanicError` exceptions at
/// the JS boundary (wasm-bindgen 0.2.118+). Reinstalling the console hook
/// would make every *caught and handled* panic also dump a stack trace to
/// `console.error`, defeating the point of exposing panics as catchable
/// exceptions — every recovery site would pollute the console with noise
/// the caller has already chosen to handle.
///
/// Hard wasm aborts (instance termination — see `start()`) remain covered
/// by the abort handler installed via `wasm_bindgen::__rt::set_on_abort`.
#[wasm_bindgen]
pub fn set_panic_hook() {
    // Only initialize tracing if a global subscriber has not already been set.
    // This makes set_panic_hook() safe to call multiple times and safe when
    // the embedding application has already configured tracing.
    if !tracing::dispatcher::has_been_set() {
        let initial_level = read_log_level_from_env()
            .and_then(|s| parse_level_filter(&s))
            .unwrap_or(tracing_subscriber::filter::LevelFilter::WARN);

        tracing_setup::init(initial_level);
    }
}

/// Entry point called when the Wasm module is instantiated.
///
/// Only compiled when the `standalone` feature is active. Downstream cdylib
/// crates that define their own `#[wasm_bindgen(start)]` should depend on
/// `automerge_subduction_wasm` with `default-features = false` and call
/// [`set_panic_hook`] from their own start function.
///
/// We install a hard-abort logging hook via `wasm_bindgen::__rt::set_on_abort`
/// so that wasm traps (instance termination — OOM, stack overflow, anything
/// the unwind runtime cannot recover from) emit a console message before the
/// module is permanently torn down. Recoverable Rust panics do not reach this
/// path: they surface as `PanicError` exceptions at the JS boundary thanks to
/// the `panic=unwind` build, which is why we no longer install
/// `console_error_panic_hook` here.
#[cfg(feature = "standalone")]
#[wasm_bindgen(start)]
pub fn start() {
    fn log_abort() {
        web_sys::console::error_1(
            &"automerge_subduction_wasm: WASM instance aborted; subsequent calls will throw \"Module terminated\""
                .into(),
        );
    }
    let _ = wasm_bindgen::__rt::set_on_abort(log_abort);

    set_panic_hook();

    tracing::info!(
        "automerge_subduction_wasm v{} ({})",
        env!("CARGO_PKG_VERSION"),
        env!("GIT_HASH")
    );
}
