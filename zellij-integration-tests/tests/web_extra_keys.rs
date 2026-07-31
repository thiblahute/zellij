//! E2E: the touch extra-keys row ported onto the web-extension infrastructure.
//!
//! Tapping a key only bumps the companion's write ack (recorded on the row's
//! `data-wrote-count`) because the tap flowed the whole way: HTML key row ->
//! pipe("extrakeys:input", bytes) -> web-extra-keys companion -> permissioned
//! write_chars (WriteToStdin) -> web_post_message ack -> HTML. So the assertion
//! proves the permission gate let the write through.
//!
//! The row is touch-only: it renders on enable but only becomes visible when a
//! soft keyboard is detected (via visualViewport). Headless has no soft keyboard,
//! so the test forces the `.visible` class after the row exists.
#![cfg(all(unix, feature = "web_e2e"))]

use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use playwright_rs::{expect, Page};
use zellij_integration_tests::web_e2e::{
    accept_permission_prompts, extra_keys_wasm, launch_chromium, login, tab_bar_wasm, WebServer,
};

const LONG: Duration = Duration::from_secs(10);

async fn wait_for_row(page: &Page) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if page.locator("#extra-keys-row").count().await? > 0 {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    bail!("#extra-keys-row never appeared");
}

#[tokio::test(flavor = "multi_thread")]
async fn extra_keys_round_trip() -> Result<()> {
    let tab = tab_bar_wasm();
    let keys = extra_keys_wasm();
    let server = WebServer::start(&[tab.as_path(), keys.as_path()])?;

    let (_pw, browser) = launch_chromium().await?;
    let page = browser.new_page().await?;
    page.set_default_timeout(15_000.0).await;

    login(&page, &server.base_url(), "e2e-extrakeys", server.token()).await?;
    // Companions only request their permissions once the browser's control
    // channel is up (~10s+ with debug wasm), so wait generously for the prompts.
    accept_permission_prompts(&page, Duration::from_secs(30), 3).await?;

    // The row is created on enable; force it visible (no soft keyboard headless).
    wait_for_row(&page).await?;
    let _: () = page
        .evaluate(
            "() => { document.getElementById('extra-keys-row').classList.add('visible'); }",
            None::<&()>,
        )
        .await?;
    expect(page.locator("#extra-keys-row"))
        .with_timeout(LONG)
        .to_be_visible()
        .await?;

    // Tap Escape -> the companion writes 1 byte and acks; the ack bumps
    // data-wrote-count on the row (0 -> a non-zero digit).
    page.locator("#extra-keys-row button[title='Escape']")
        .click(None)
        .await?;
    expect(page.locator("#extra-keys-row"))
        .with_timeout(LONG)
        .to_have_attribute_regex("data-wrote-count", r"[1-9]")
        .await?;

    // Exercise the sticky-modifier UI: arm Ctrl (reads "armed"), then a named
    // key releases it.
    page.locator("#extra-keys-row button[title='Ctrl']")
        .click(None)
        .await?;
    expect(page.locator("#extra-keys-row button[title='Ctrl'].armed"))
        .with_timeout(Duration::from_secs(5))
        .to_be_visible()
        .await?;
    page.locator("#extra-keys-row button[title='Left']")
        .click(None)
        .await?;
    expect(page.locator("#extra-keys-row button[title='Ctrl'].armed"))
        .with_timeout(Duration::from_secs(5))
        .to_have_count(0)
        .await?;

    browser.close().await?;
    Ok(())
}
