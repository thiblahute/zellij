//! E2E: the tab bar ported onto the web-extension infrastructure.
//!
//! This drives the ported web-tabs sidebar (left `#tab-sidebar` tree of
//! `.tab-item`s, `+ New tab`, inline rename, `×` close). Each assertion checks
//! the effect of an action, which only changes because it flowed the whole way:
//! HTML sidebar -> web pipe -> web-tab-bar companion -> permissioned tab action
//! -> zellij TabUpdate -> companion posts the tab list -> HTML re-renders.
//! Close is by stable `tab_id` (not position), so a close targets the right tab.
#![cfg(all(unix, feature = "web_e2e"))]

use std::time::Duration;

use anyhow::Result;
use playwright_rs::expect;
use zellij_integration_tests::web_e2e::{
    accept_permission_prompts, extra_keys_wasm, launch_chromium, login, tab_bar_wasm, WebServer,
};

const LONG: Duration = Duration::from_secs(10);
const ACTIVE: &str = r"(^|\s)active(\s|$)";

#[tokio::test(flavor = "multi_thread")]
async fn tab_bar_round_trip() -> Result<()> {
    let tab = tab_bar_wasm();
    let keys = extra_keys_wasm();
    let server = WebServer::start(&[tab.as_path(), keys.as_path()])?;

    let (_pw, browser) = launch_chromium().await?;
    let page = browser.new_page().await?;
    page.set_default_timeout(15_000.0).await;

    login(&page, &server.base_url(), "e2e-tabbar", server.token()).await?;
    // The companions only request their permissions once the browser's control
    // channel is up, which with debug wasm can be ~10s+ after connect, so wait
    // generously for the prompts before giving up.
    accept_permission_prompts(&page, Duration::from_secs(30), 3).await?;

    // The sidebar renders once the companion is enabled and its frontend loaded;
    // the tab list arrives via TabUpdate once the companion's permissions are
    // granted, so the first tab item can take a moment.
    expect(page.locator("#tab-sidebar"))
        .with_timeout(LONG)
        .to_be_visible()
        .await?;
    expect(page.locator("#tab-sidebar-list .tab-item").first())
        .with_timeout(LONG)
        .to_be_visible()
        .await?;
    let start = page.locator("#tab-sidebar-list .tab-item").count().await?;
    assert!(start >= 1, "expected at least one tab, got {start}");

    // 1) New tab -> count grows. The new-tab button opens an inline rename on the
    //    fresh tab; cancel it with Escape so it doesn't commit on blur.
    page.locator("#tab-sidebar-new-tab").click(None).await?;
    expect(page.locator("#tab-sidebar-list .tab-item"))
        .with_timeout(LONG)
        .to_have_count(start + 1)
        .await?;
    if page.locator(".tab-item-rename-input").count().await? > 0 {
        page.locator(".tab-item-rename-input")
            .press("Escape", None)
            .await
            .ok();
    }

    // 2) Switch to the first tab -> it becomes active.
    page.locator("#tab-sidebar-list .tab-item")
        .first()
        .click(None)
        .await?;
    expect(page.locator("#tab-sidebar-list .tab-item").first())
        .with_timeout(LONG)
        .to_have_class_regex(ACTIVE)
        .await?;

    // 3) Rename the active tab via its ✎ affordance -> its label updates.
    let active = page.locator("#tab-sidebar-list .tab-item.active");
    active.hover(None).await.ok();
    active.locator(".tab-item-rename").click(None).await?;
    let input = page.locator(".tab-item-rename-input");
    input.fill("web-renamed", None).await?;
    input.press("Enter", None).await?;
    expect(page.locator("#tab-sidebar-list"))
        .with_timeout(LONG)
        .to_contain_text("web-renamed")
        .await?;

    // 4) Close a tab by its × (stable tab_id) -> count shrinks back.
    let before_close = page.locator("#tab-sidebar-list .tab-item").count().await?;
    let last = page.locator("#tab-sidebar-list .tab-item").last();
    last.hover(None).await.ok();
    last.locator(".tab-item-close").click(None).await?;
    expect(page.locator("#tab-sidebar-list .tab-item"))
        .with_timeout(LONG)
        .to_have_count(before_close - 1)
        .await?;

    browser.close().await?;
    Ok(())
}
