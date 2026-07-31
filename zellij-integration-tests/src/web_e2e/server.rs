//! A throwaway `zellij web` server for the browser E2E tests.
//!
//! Fully isolated: its own `ZELLIJ_SOCKET_DIR` and `XDG_CACHE_HOME` (so
//! `permissions.kdl` is a temp file, the permission prompt fires deterministically
//! on every run, and the developer's real `~/.cache/zellij` is never touched), an
//! ephemeral loopback port, and a config that declares the web extensions under
//! test. The server (and the session server it spawns) is killed and all temp
//! state removed on drop.

use std::fs;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, ensure, Context, Result};

use super::zellij_bin;

pub struct WebServer {
    child: Child,
    pgid: i32,
    port: u16,
    token: String,
    log: PathBuf,
    // Removed on drop; holds the socket dir, cache dir, and config file.
    _tmp: tempfile::TempDir,
}

impl WebServer {
    /// Start a web server declaring `extensions` (paths to companion wasm files).
    pub fn start(extensions: &[&Path]) -> Result<Self> {
        let bin = zellij_bin();
        ensure!(
            bin.exists(),
            "zellij binary not found at {}\nBuild it first:\n  \
             cargo build --bin zellij --no-default-features --features vendored_curl,web_server_capability\n\
             (or point ZELLIJ_E2E_BIN at an existing binary)",
            bin.display()
        );
        for ext in extensions {
            ensure!(
                ext.exists(),
                "web-extension wasm not found at {}\nBuild it first:\n  \
                 cargo build -p <plugin-name> --target wasm32-wasip1",
                ext.display()
            );
        }

        let tmp = tempfile::tempdir().context("create temp dir")?;
        let sock = tmp.path().join("sock");
        let cache = tmp.path().join("cache");
        fs::create_dir_all(&sock)?;
        fs::create_dir_all(&cache)?;

        let conf = tmp.path().join("config.kdl");
        fs::write(&conf, config_kdl(extensions)).context("write config")?;

        let port = free_port().context("reserve a port")?;

        // Both invocations share the same isolated socket dir + cache.
        // Pin TMPDIR too so the session server's own tmp/log dir (ZELLIJ_TMP_DIR
        // derives from it) stays inside our sandbox instead of the shared
        // /tmp/zellij-<uid>, keeping runs isolated from the developer's live server.
        let tmproot = tmp.path().to_path_buf();
        let with_env = |c: &mut Command| {
            c.env("ZELLIJ_SOCKET_DIR", &sock)
                .env("XDG_CACHE_HOME", &cache)
                .env("TMPDIR", &tmproot);
        };

        // Mint a login token.
        let mut mint = Command::new(&bin);
        mint.arg("--config")
            .arg(&conf)
            .args(["web", "--create-token"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        with_env(&mut mint);
        let out = mint.output().context("run `web --create-token`")?;
        let token = extract_uuid(&String::from_utf8_lossy(&out.stdout))
            .ok_or_else(|| anyhow!("no token in `web --create-token` output"))?;

        // Start the server, logging to a persistent file we can tail on failure.
        let log = std::env::temp_dir().join(format!("zellij-web-e2e-{port}.log"));
        let logf = fs::File::create(&log).context("create server log")?;
        let mut srv = Command::new(&bin);
        srv.arg("--config")
            .arg(&conf)
            .args(["web", "--start", "--ip", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .stdout(Stdio::from(logf.try_clone()?))
            .stderr(Stdio::from(logf));
        with_env(&mut srv);
        // Own process group so drop can reap the server and any children it spawns.
        srv.process_group(0);
        let child = srv.spawn().context("spawn web server")?;
        let pgid = child.id() as i32;

        let mut server = WebServer {
            child,
            pgid,
            port,
            token,
            log,
            _tmp: tmp,
        };
        server.wait_ready(Duration::from_secs(20))?;
        Ok(server)
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn wait_ready(&mut self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return Ok(());
            }
            if let Ok(Some(status)) = self.child.try_wait() {
                bail!(
                    "web server exited early ({status}); log:\n{}",
                    tail(&self.log)
                );
            }
            sleep(Duration::from_millis(200));
        }
        bail!(
            "web server did not open port {} within {timeout:?}; log:\n{}",
            self.port,
            tail(&self.log)
        );
    }
}

impl Drop for WebServer {
    fn drop(&mut self) {
        // Kill the web server's process group.
        unsafe {
            libc::kill(-self.pgid, libc::SIGTERM);
        }
        sleep(Duration::from_millis(300));
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
        let _ = self.child.wait();

        // The session server that zellij spawns detaches into its own session, so
        // the group kill above misses it. Reap it by its unique temp socket-dir
        // path (nothing else on the system references this random directory).
        if let Some(sock) = self._tmp.path().join("sock").to_str() {
            let _ = Command::new("pkill").args(["-9", "-f", sock]).status();
        }

        let _ = fs::remove_file(&self.log);
    }
}

fn config_kdl(extensions: &[&Path]) -> String {
    let mut lines = String::new();
    for ext in extensions {
        lines.push_str(&format!(
            "        plugin location=\"file:{}\"\n",
            ext.display()
        ));
    }
    format!("web_client {{\n    extensions {{\n{lines}    }}\n}}\n")
}

fn free_port() -> Result<u16> {
    // Bind to :0, read the assigned port, then drop the listener to free it.
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Find the first UUID-shaped token (8-4-4-4-12 hex) in `s`.
fn extract_uuid(s: &str) -> Option<String> {
    s.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .find(|tok| is_uuid(tok))
        .map(str::to_string)
}

fn is_uuid(t: &str) -> bool {
    let parts: Vec<&str> = t.split('-').collect();
    let lens = [8usize, 4, 4, 4, 12];
    parts.len() == 5
        && parts
            .iter()
            .zip(lens)
            .all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The last ~30 lines of a log file, for error messages.
fn tail(path: &Path) -> String {
    let mut buf = String::new();
    if let Ok(mut f) = fs::File::open(path) {
        let _ = f.read_to_string(&mut buf);
    }
    let lines: Vec<&str> = buf.lines().collect();
    let start = lines.len().saturating_sub(30);
    lines[start..].join("\n")
}
