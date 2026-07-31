//! Browser end-to-end tests for the Zellij web client and its web extensions.
//!
//! These helpers drive a real headless Chromium (via [`playwright-rs`]) against a
//! throwaway `zellij web` server whose config declares the web-extension
//! companions. The tests (in `tests/web_*.rs`) each assert the *effect* of a
//! browser action, so a green run exercises the whole round-trip: HTML frontend
//! -> web pipe -> permissioned companion -> core action -> `web_post_message` ->
//! HTML update.
//!
//! Gated behind the `web_e2e` cargo feature (off by default): enabling it pulls
//! in [`playwright-rs`], whose build script downloads a ~90 MB Playwright driver,
//! and the tests additionally need a built `zellij` binary, the plugin wasm
//! artifacts, a Playwright browser, and Node.js. With the feature off the crate
//! builds and tests exactly as before and never touches any of that.
//!
//! ```text
//! # prerequisites (built once):
//! cargo build --bin zellij --no-default-features \
//!     --features vendored_curl,web_server_capability
//! cargo build -p web-tab-bar    --target wasm32-wasip1
//! cargo build -p web-extra-keys --target wasm32-wasip1
//! npx playwright@1.61.1 install chromium   # browser, without OS deps
//!
//! cargo test -p zellij-integration-tests --features web_e2e -- --nocapture
//! ```
//!
//! Artifact paths are discovered under the workspace `target/` and can be
//! overridden with `ZELLIJ_E2E_BIN`, `ZELLIJ_E2E_TAB_BAR_WASM`,
//! `ZELLIJ_E2E_EXTRA_KEYS_WASM`.
//!
//! [`playwright-rs`]: https://github.com/padamson/playwright-rust

mod browser;
mod server;

pub use browser::{accept_permission_prompts, dump_state, launch_chromium, login};
pub use server::WebServer;

use std::path::PathBuf;

/// The workspace target directory (honors `CARGO_TARGET_DIR`).
fn target_dir() -> PathBuf {
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(dir) => PathBuf::from(dir),
        // CARGO_MANIFEST_DIR is this crate; its parent is the workspace root.
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crate dir has a parent")
            .join("target"),
    }
}

/// Path to the built `zellij` binary (override with `ZELLIJ_E2E_BIN`).
pub fn zellij_bin() -> PathBuf {
    std::env::var_os("ZELLIJ_E2E_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| target_dir().join("debug/zellij"))
}

fn plugin_wasm(name: &str, env_override: &str) -> PathBuf {
    std::env::var_os(env_override)
        .map(PathBuf::from)
        .unwrap_or_else(|| target_dir().join(format!("wasm32-wasip1/debug/{name}.wasm")))
}

/// Path to the web-tab-bar companion wasm (override with `ZELLIJ_E2E_TAB_BAR_WASM`).
pub fn tab_bar_wasm() -> PathBuf {
    plugin_wasm("web-tab-bar", "ZELLIJ_E2E_TAB_BAR_WASM")
}

/// Path to the web-extra-keys companion wasm (override with `ZELLIJ_E2E_EXTRA_KEYS_WASM`).
pub fn extra_keys_wasm() -> PathBuf {
    plugin_wasm("web-extra-keys", "ZELLIJ_E2E_EXTRA_KEYS_WASM")
}
