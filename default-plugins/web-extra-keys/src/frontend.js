// Termux-style extra-keys row, the frontend of the `web-extra-keys` companion.
//
// A faithful port of the web client's touch extra-keys row: modifier + special
// keys a soft keyboard can't produce, floating full-width above the keyboard and
// shown only while it's up. Two kinds of keys:
//   - "modifier": CTRL / ALT / SUPER are sticky — armed by a tap, applied to the
//     NEXT key (whether from this row or the OS soft keyboard), then released.
//   - "key": sends bytes immediately (Edit, ESC, TAB, arrows), honoring any
//     armed sticky modifier so e.g. CTRL then a row key also composes.
//
// The row holds no authority: it computes the terminal bytes and pipes them to
// its companion, which writes them under WriteToStdin. It also registers
// `window.__zjApplyStickyModifiers`, which the web client's soft-keyboard
// capture calls to apply the armed modifiers to characters typed on the OS
// keyboard (Ctrl armed + typing "f" -> 0x06), routing digit/letter chords
// through the browser-shortcut layer first (Ctrl+k, Alt+s, Alt+n/r, ...).
//
// Served at /assets/webext/<web_plugin_id>.js, so the core hub is one level up.
import { registerWebExtension } from "../web-extensions.js";

const HAS_HOVER = !!(window.matchMedia && window.matchMedia("(hover: hover)").matches);

// CTRL / ALT are sticky — armed by a tap, applied to the next key then released.
const stickyMods = { ctrl: false, alt: false, meta: false };

// Short labels so all keys fit one row on a narrow phone; `title` gives the full
// name. "Edit" fires zellij's scrollback-in-editor flow (Ctrl+s then e in the
// default binds), where an editor gives real keyboard selection/yank.
const EXTRA_KEYS = [
    { type: "modifier", mod: "ctrl", label: "^", title: "Ctrl" },
    { type: "modifier", mod: "alt", label: "⎇", title: "Alt" },
    { type: "modifier", mod: "meta", label: "Sup", title: "Super" },
    { type: "key", label: "Edit", bytes: "\x13e", title: "Edit scrollback in editor" },
    { type: "key", label: "esc", bytes: "\x1b", title: "Escape" },
    { type: "key", label: "tab", bytes: "\t", title: "Tab" },
    { type: "key", label: "◀", bytes: "\x1b[D", title: "Left" },
    { type: "key", label: "▲", bytes: "\x1b[A", title: "Up" },
    { type: "key", label: "▼", bytes: "\x1b[B", title: "Down" },
    { type: "key", label: "▶", bytes: "\x1b[C", title: "Right" },
];

let ext = null;

// The permissioned companion writes these bytes to the focused terminal.
function sendKeys(bytes) {
    if (ext) {
        ext.pipe("extrakeys:input", bytes);
    }
}

// Ask the web client to refit the terminal after the reserved row height changed.
function requestTerminalRefit() {
    window.dispatchEvent(new CustomEvent("zellij:rendering-resize"));
}

function releaseStickyMods() {
    const wasArmed = stickyMods.ctrl || stickyMods.alt || stickyMods.meta;
    stickyMods.ctrl = false;
    stickyMods.alt = false;
    stickyMods.meta = false;
    if (wasArmed) {
        updateExtraKeyState();
    }
}

// Turn a character into the bytes a Ctrl/Alt chord produces (Ctrl+f -> 0x06,
// Alt+x -> ESC x).
function toModifiedBytes(ch, ctrl, alt) {
    let out = ch;
    if (ctrl && ch.length === 1) {
        const code = ch.toLowerCase().charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
            out = String.fromCharCode(code & 0x1f);
        }
    }
    if (alt) {
        out = "\x1b" + out; // ESC prefix = Alt/Meta
    }
    return out;
}

// Named keys (from the row) that also map to browser shortcuts, so a modified
// row key (e.g. Ctrl + row-TAB) dispatches a synthetic keydown.
const NAMED_KEY_EVENTS = {
    "\t": { key: "Tab", code: "Tab" },
    "\x1b[A": { key: "ArrowUp", code: "ArrowUp" },
    "\x1b[B": { key: "ArrowDown", code: "ArrowDown" },
    "\x1b[C": { key: "ArrowRight", code: "ArrowRight" },
    "\x1b[D": { key: "ArrowLeft", code: "ArrowLeft" },
};

// Synthesize a real keydown for a modified letter/digit/named-key and dispatch
// it so the browser-shortcut layer fires exactly as with a physical keyboard.
// Returns true if a shortcut consumed it (called preventDefault).
function dispatchSyntheticShortcut(ch, ctrl, alt, meta) {
    let key, code;
    const named = NAMED_KEY_EVENTS[ch];
    if (named) {
        key = named.key;
        code = named.code;
    } else if (ch.length === 1 && /^[a-z]$/.test(ch.toLowerCase())) {
        key = ch;
        code = "Key" + ch.toLowerCase().toUpperCase();
    } else if (ch.length === 1 && /^[0-9]$/.test(ch)) {
        key = ch;
        code = "Digit" + ch;
    } else {
        return false;
    }
    const ev = new KeyboardEvent("keydown", {
        key,
        code,
        ctrlKey: ctrl,
        altKey: alt,
        shiftKey: false,
        metaKey: meta,
        bubbles: true,
        cancelable: true,
    });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
}

// Apply the armed sticky modifiers to one key. A single typed character routes
// through the browser-shortcut layer first; if no shortcut consumes it, fall
// through to the modified terminal bytes. Returns null when a shortcut swallowed
// it (send nothing). Super/meta has no terminal encoding, so it only matters for
// browser shortcuts. Registered as window.__zjApplyStickyModifiers.
function applyStickyModifiers(ch) {
    const ctrl = stickyMods.ctrl;
    const alt = stickyMods.alt;
    const meta = stickyMods.meta;
    if (!ctrl && !alt && !meta) {
        return ch; // nothing armed — normal typing is untouched
    }
    if (dispatchSyntheticShortcut(ch, ctrl, alt, meta)) {
        releaseStickyMods();
        return null; // consumed by a browser shortcut
    }
    const out = toModifiedBytes(ch, ctrl, alt);
    releaseStickyMods();
    return out;
}

function updateExtraKeyState() {
    const container = document.getElementById("extra-keys-row");
    if (!container) {
        return;
    }
    container.querySelectorAll(".extra-key[data-mod]").forEach((btn) => {
        btn.classList.toggle("armed", !!stickyMods[btn.dataset.mod]);
    });
}

function buildRow() {
    injectStyles();
    let container = document.getElementById("extra-keys-row");
    if (!container) {
        container = document.createElement("div");
        container.id = "extra-keys-row";
        document.body.appendChild(container);
    }
    // The web client's soft-keyboard capture calls this for OS-typed characters.
    window.__zjApplyStickyModifiers = applyStickyModifiers;
    container.replaceChildren();
    for (const key of EXTRA_KEYS) {
        const btn = document.createElement("button");
        btn.className = "extra-key";
        btn.textContent = key.label;
        if (key.title) {
            btn.title = key.title;
            btn.setAttribute("aria-label", key.title);
        }
        // don't steal focus from the soft-keyboard capture input
        btn.addEventListener("mousedown", (e) => e.preventDefault());
        if (key.type === "modifier") {
            btn.dataset.mod = key.mod;
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                stickyMods[key.mod] = !stickyMods[key.mod];
                updateExtraKeyState();
            });
        } else {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                // a row key also honors an armed sticky modifier
                const out = applyStickyModifiers(key.bytes);
                if (out !== null) {
                    sendKeys(out);
                }
            });
        }
        container.appendChild(btn);
    }
    updateExtraKeyState();
    setupExtraKeysPositioning();
}

// The row floats above the soft keyboard: shown only while the keyboard is up,
// glued to the top edge of the keyboard. A `position: fixed` element anchors to
// the LAYOUT viewport, so on scroll a bottom-anchored bar drifts. We detect the
// keyboard from how much the visual viewport shrank and reserve the row's height
// so the terminal shrinks above it.
let positioningInstalled = false;
function setupExtraKeysPositioning() {
    if (positioningInstalled) {
        return;
    }
    const container = document.getElementById("extra-keys-row");
    const vv = window.visualViewport;
    // Touch-only: on a hover device there is no soft keyboard and the
    // viewport-shrink heuristic would false-positive on devtools/zoom/resize.
    if (!container || !vv || HAS_HOVER) {
        return;
    }
    positioningInstalled = true;
    const KEYBOARD_MIN_INSET_PX = 120;
    let maxSeenHeight = 0;
    let lastReservedHeight = -1;
    const reposition = () => {
        const current = Math.max(window.innerHeight, vv.height);
        if (current > maxSeenHeight) {
            maxSeenHeight = current;
        }
        const shrink = maxSeenHeight - current;
        const kbdVisible = shrink > KEYBOARD_MIN_INSET_PX;
        container.classList.toggle("visible", kbdVisible);
        const rowHeight = kbdVisible ? container.offsetHeight || 50 : 0;
        if (rowHeight !== lastReservedHeight) {
            lastReservedHeight = rowHeight;
            document.documentElement.style.setProperty(
                "--zj-extra-keys-height",
                `${rowHeight}px`
            );
            requestTerminalRefit();
        }
    };
    reposition();
    vv.addEventListener("resize", reposition);
    vv.addEventListener("scroll", reposition);
}

function injectStyles() {
    if (document.getElementById("zj-extra-keys-style")) {
        return;
    }
    const style = document.createElement("style");
    style.id = "zj-extra-keys-style";
    style.textContent = `
      #extra-keys-row {
        position: fixed; left: 0; right: 0; bottom: 0;
        z-index: 40; display: none; flex-wrap: nowrap;
        gap: 3px; padding: 4px 4px; width: 100vw; box-sizing: border-box;
        background: var(--zj-surface);
        border-top: 1px solid color-mix(in srgb, var(--zj-fg) 15%, transparent);
      }
      #extra-keys-row.visible { display: flex; }
      .extra-key {
        flex: 1 1 0; min-width: 0; height: 34px; padding: 0 2px;
        border: 1px solid color-mix(in srgb, var(--zj-fg) 18%, transparent);
        border-radius: 6px; background: var(--zj-surface-hover);
        color: var(--zj-fg); font-family: var(--zj-ui-font); font-size: 13px;
        line-height: 1; cursor: pointer; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
      }
      .extra-key:active { background: var(--zj-surface-active); }
      .extra-key.armed {
        background: var(--zj-fg); color: var(--zj-bg); border-color: var(--zj-fg);
      }
    `;
    document.head.appendChild(style);
}

ext = registerWebExtension("web-extra-keys.wasm", {
    onEnabled() {
        buildRow();
    },
    onReset() {
        releaseStickyMods();
    },
    // The companion acks each write ({kind:"wrote",bytes:N}). Nothing to render,
    // but record it on the row so the round-trip is observable (debugging + e2e):
    // data-wrote-bytes is the last write's byte count, data-wrote-count the total.
    onMessage(payload) {
        let msg;
        try {
            msg = JSON.parse(payload);
        } catch (_) {
            return;
        }
        if (msg && msg.kind === "wrote") {
            const row = document.getElementById("extra-keys-row");
            if (row) {
                row.dataset.wroteBytes = String(msg.bytes);
                row.dataset.wroteCount = String(
                    (parseInt(row.dataset.wroteCount || "0", 10) || 0) + 1
                );
            }
        }
    },
});
