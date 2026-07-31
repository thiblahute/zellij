// Web-extension routing hub (core web-client side).
//
// Several web extensions can be enabled for one client, each backed by its own
// companion WASM plugin that carries its own browser frontend. The core web client
// ships NO extension code; instead:
//   - the server enables a companion and announces it (WebPluginEnabled) with a
//     distinct, unguessable web_plugin_id and the extension name;
//   - it then serves that companion's frontend at /assets/webext/<id>.js and signals
//     the browser (WebPluginFrontend); we dynamically import it, and the module
//     self-registers here via registerWebExtension();
//   - every message from a companion is stamped with its id (WebPluginMessage), so a
//     frontend only ever sees its own companion and can only pipe back to it.
//
// The id is the capability, minted and validated server-side.

const handlers = []; // { match, onEnabled, onMessage, onReset, id }
const byId = new Map(); // web_plugin_id -> handler
const extById = new Map(); // web_plugin_id -> extension name (recorded at enable)
const importedIds = new Set(); // web_plugin_ids whose frontend module we've imported

let getWsControl = () => null;
let getOwnWebClientId = () => "";

export function initWebExtensions(wsControlGetter, ownWebClientIdGetter) {
    getWsControl = wsControlGetter;
    getOwnWebClientId = ownWebClientIdGetter;
    // Control socket (re)connected: forget stale bindings; the server re-announces
    // and re-serves each frontend.
    byId.clear();
    extById.clear();
    for (const h of handlers) {
        h.id = null;
        if (h.onReset) h.onReset();
    }
}

// A frontend (imported from /assets/webext/<id>.js) registers interest in an
// extension whose url/name contains `match` (e.g. "web-tab-bar.wasm").
// `api.pipe(name, payload)` sends to its own companion.
export function registerWebExtension(match, api) {
    const handler = {
        match,
        onEnabled: api.onEnabled || (() => {}),
        onMessage: api.onMessage || (() => {}),
        onReset: api.onReset || null,
        id: null,
    };
    handler.pipe = (name, payload) => {
        if (!handler.id) return;
        pipeRaw(handler.id, name, payload);
    };
    api.pipe = handler.pipe;
    handlers.push(handler);
    return handler;
}

// A companion was enabled: record which extension this id is, and wait for its
// frontend to be served (onWebPluginFrontend) before importing/dispatching.
export function onWebPluginEnabled(extension, webPluginId) {
    extById.set(webPluginId, extension);
}

// The companion's frontend is now served at /assets/webext/<id>.js — import it (it
// self-registers via registerWebExtension), then dispatch enable to its handler.
export async function onWebPluginFrontend(webPluginId) {
    if (!importedIds.has(webPluginId)) {
        importedIds.add(webPluginId);
        try {
            await import(`/assets/webext/${webPluginId}.js`);
        } catch (e) {
            importedIds.delete(webPluginId);
            console.error(`[web-ext] failed to import frontend for ${webPluginId}:`, e);
            return;
        }
    }
    const extension = extById.get(webPluginId) || "";
    const handler = handlers.find((h) => extension.includes(h.match));
    if (!handler) {
        console.log(`[web-ext] no frontend registered for ${extension}`);
        return;
    }
    handler.id = webPluginId;
    byId.set(webPluginId, handler);
    handler.onEnabled(webPluginId, extension);
    console.log(`[web-ext] enabled ${extension} -> ${webPluginId.slice(0, 8)}`);
}

export function onWebPluginMessage(webPluginId, payload) {
    const handler = byId.get(webPluginId);
    if (!handler) {
        console.log(`[web-ext] message for unknown id ${webPluginId}`);
        return;
    }
    handler.onMessage(payload);
}

// A companion is asking the user to grant permissions. Prompt in the browser (the
// headless companion has no pane for the usual dialog); the answer grants through
// the normal plugin-permission path server-side, so it caches and won't re-prompt.
export function onWebPluginPermissionRequest(webPluginId, permissions) {
    const extension = extById.get(webPluginId) || webPluginId.slice(0, 8);
    showPermissionModal(extension, permissions || [], (granted) => {
        const wsControl = getWsControl();
        const ownWebClientId = getOwnWebClientId();
        if (!wsControl || !ownWebClientId) return;
        wsControl.send(
            JSON.stringify({
                web_client_id: ownWebClientId,
                payload: {
                    type: "WebPluginPermissionResponse",
                    web_plugin_id: webPluginId,
                    granted,
                },
            })
        );
    });
}

function extName(extension) {
    // Show the wasm basename rather than the full file: url.
    const m = extension.match(/([^/\\]+)\.wasm$/);
    return m ? m[1] : extension;
}

function showPermissionModal(extension, permissions, respond) {
    const overlay = document.createElement("div");
    overlay.className = "zj-perm-overlay";
    overlay.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647",
        "display:flex", "align-items:center", "justify-content:center",
        "background:rgba(0,0,0,0.5)", "font:13px/1.5 system-ui,sans-serif",
    ].join(";");

    const box = document.createElement("div");
    box.style.cssText = [
        "min-width:300px", "max-width:420px", "color:#e6e6ee",
        "background:#1e1e2a", "border:1px solid #444", "border-radius:10px",
        "padding:16px 18px", "box-shadow:0 8px 32px rgba(0,0,0,0.5)",
    ].join(";");

    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;margin-bottom:8px;";
    title.textContent = `Web extension "${extName(extension)}" requests permissions`;
    box.appendChild(title);

    const list = document.createElement("ul");
    list.style.cssText = "margin:8px 0 14px 0;padding-left:18px;";
    for (const p of permissions) {
        const li = document.createElement("li");
        li.textContent = p;
        list.appendChild(li);
    }
    if (!permissions.length) {
        const li = document.createElement("li");
        li.textContent = "(none)";
        list.appendChild(li);
    }
    box.appendChild(list);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
    const mkBtn = (label, granted, primary) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = primary ? "zj-perm-allow" : "zj-perm-deny";
        b.style.cssText =
            "cursor:pointer;font:12px system-ui;padding:5px 12px;border-radius:6px;" +
            (primary
                ? "background:#5b5be0;color:#fff;border:1px solid #5b5be0;"
                : "background:#2b2b3a;color:#e0e0e0;border:1px solid #555;");
        b.addEventListener("click", () => {
            overlay.remove();
            respond(granted);
        });
        return b;
    };
    row.appendChild(mkBtn("Deny", false, false));
    row.appendChild(mkBtn("Allow", true, true));
    box.appendChild(row);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

function pipeRaw(webPluginId, name, payload) {
    const wsControl = getWsControl();
    const ownWebClientId = getOwnWebClientId();
    if (!wsControl || !ownWebClientId) return;
    wsControl.send(
        JSON.stringify({
            web_client_id: ownWebClientId,
            payload: {
                type: "PipeToPlugin",
                web_plugin_id: webPluginId,
                name,
                payload,
            },
        })
    );
}
