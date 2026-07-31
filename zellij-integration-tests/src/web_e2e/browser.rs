//! Thin browser helpers shared by the E2E tests: launch a headless Chromium,
//! log in through the token form, and accept the web-extension permission
//! prompts. Everything else (the per-feature assertions) lives in `tests/`.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use playwright_rs::{Browser, GotoOptions, LaunchOptions, Page, Playwright, WaitUntil};
use tokio::time::sleep;

/// The install hint shown when Chromium is missing. We deliberately do NOT call
/// `playwright_rs::install_browsers`: it forces `--with-deps` on Linux, which on
/// non-Debian distros either fails on `apt-get` or (once the browser is present)
/// hangs on a `sudo` password prompt for the OS-dependency step. The browser is
/// provisioned out-of-band instead; the driver and it are the same Playwright
/// version, so the driver finds it.
const INSTALL_HINT: &str =
    "install the Playwright browser without OS deps:\n  npx playwright@1.61.1 install chromium";

/// Launch a headless Chromium. Returns the `Playwright` handle too: it owns the
/// driver process and must stay alive for as long as the browser is used.
pub async fn launch_chromium() -> Result<(Playwright, Browser)> {
    let playwright = Playwright::launch().await?;
    let browser = playwright
        .chromium()
        .launch_with_options(LaunchOptions::new().headless(true).args(vec![
            "--no-sandbox".to_string(),
            "--disable-dev-shm-usage".to_string(),
        ]))
        .await
        .map_err(|e| anyhow!("failed to launch Chromium ({e}); {INSTALL_HINT}"))?;
    Ok((playwright, browser))
}

/// Navigate to a named session and, if the token form is shown, log in.
pub async fn login(page: &Page, base_url: &str, session: &str, token: &str) -> Result<()> {
    // A named session avoids the base-URL new-session redirect loop.
    let url = format!("{}/{}", base_url.trim_end_matches('/'), session);
    // Wait for DOMContentLoaded, not `load`: the web client holds a persistent
    // websocket open, so the `load` event can be delayed indefinitely.
    page.goto(
        &url,
        Some(
            GotoOptions::new()
                .wait_until(WaitUntil::DomContentLoaded)
                .timeout(Duration::from_secs(15)),
        ),
    )
    .await?;

    // The token form may or may not appear (a cached client goes straight in).
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if page.locator("#token").count().await? > 0 {
            page.locator("#token").fill(token, None).await?;
            page.locator("#submit").click(None).await?;
            break;
        }
        sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}

/// Click "Allow" on every web-extension permission prompt that appears.
///
/// With an isolated cache the grant is never cached, so the enabled companions
/// each prompt once. Waits up to `appear` for the next prompt and accepts at
/// most `max` (a cap so a prompt that won't dismiss can't spin forever).
pub async fn accept_permission_prompts(page: &Page, appear: Duration, max: u32) -> Result<u32> {
    let mut accepted = 0;
    while accepted < max {
        if !wait_for_prompt(page, appear).await? {
            break;
        }
        let before = page.locator(".zj-perm-allow").count().await?;
        // The prompt overlays stack (each is fixed/inset:0 at max z-index), so
        // the topmost is the LAST in DOM order. Click that one: clicking an
        // earlier one hits a button covered by a later overlay and does nothing.
        page.locator(".zj-perm-allow").last().click(None).await?;
        accepted += 1;

        // Wait until the allow-button count drops (prompt dismissed) or 3s.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut after = before;
        while Instant::now() < deadline {
            after = page.locator(".zj-perm-allow").count().await?;
            if after < before {
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
        if after >= before {
            eprintln!("[web-e2e] clicking Allow did not dismiss the permission prompt");
            dump_state(page, "stuck-prompt").await.ok();
            break;
        }
    }
    Ok(accepted)
}

async fn wait_for_prompt(page: &Page, timeout: Duration) -> Result<bool> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if page.locator(".zj-perm-allow").count().await? > 0 {
            return Ok(true);
        }
        sleep(Duration::from_millis(150)).await;
    }
    Ok(false)
}

/// Print a text snapshot of the permission/tab-bar state (for diagnosing hangs).
pub async fn dump_state(page: &Page, label: &str) -> Result<()> {
    let js = r#"() => JSON.stringify({
        allow: document.querySelectorAll('.zj-perm-allow').length,
        deny: document.querySelectorAll('.zj-perm-deny').length,
        tab_bar: (document.querySelector('#zj-tab-bar')||{}).className ?? null,
        tabs: document.querySelectorAll('#zj-tab-bar .zj-tab').length,
        extra_keys: (document.querySelector('#zj-extra-keys')||{}).className ?? null,
        ids: Array.from(document.querySelectorAll('[id]')).map(e => e.id).slice(0, 25),
        perm_html: (() => { const p = document.querySelector('[class*="perm"]'); return p ? p.outerHTML.slice(0, 700) : null; })()
    })"#;
    let s: String = page.evaluate(js, None::<&()>).await?;
    eprintln!("[web-e2e][{label}] {s}");
    Ok(())
}
