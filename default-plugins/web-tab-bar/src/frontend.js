// HTML tab bar — the frontend of the `web-tab-bar` companion plugin.
//
// A FAITHFUL port of the web-tabs branch's tab-bar sidebar
// (zellij-client/assets/tabs.js): the name-derived folder tree, drag-to-rename
// into folders, the Ctrl+K fuzzy palette, the Alt+Tab MRU switcher HUD, the
// pinned/overlay/hidden bar modes, the toggle chip / touch toggle bar, and the
// config-driven shortcuts — all rendered as DOM chrome outside the terminal grid.
//
// The tab-bar LOGIC below (everything between the imports and the web-extension
// glue at the bottom) is copied verbatim from tabs.js. Only three things are
// rewired for the web-extension architecture:
//   - sendPayload() pipes actions to this companion (which performs them through
//     its granted permissions) instead of speaking the raw control channel;
//   - the DOM scaffold + CSS are created/injected by the frontend itself on
//     enable, so the core web client ships no tab-bar markup;
//   - tab data arrives via onMessage ({kind:"tabs"} / {kind:"config"}) instead of
//     TabUpdate / SetConfig control messages.
// The Termux extra-keys row that also lived in tabs.js belongs to the separate
// `web-extra-keys` companion and is intentionally absent here.
//
// Served at /assets/webext/<web_plugin_id>.js, so the core hub is one level up.
import { registerWebExtension } from "../web-extensions.js";

// Tab bar display mode, persisted per browser:
//   "hidden"  - only the bottom-left chip (with the active tab's name)
//   "overlay" - floats translucent over the terminal (Alt+s peek)
//   "pinned"  - takes layout space beside the terminal (chip click)
const MODE_KEY = "zellij:tab-bar-mode";
let barMode = "pinned";

let getWsControl = null;
let getOwnWebClientId = null;
let getSendAnsiKey = null;
let tabs = [];
// Canonical alphabetical view, refreshed whenever `tabs` (or a tab name) changes.
// The sidebar tree, the switcher HUD, the palette's empty-query order, Alt+Tab/arrows
// cycling and Alt+N digit jumps all walk this order, so siblings in the same
// name-derived folder stay adjacent as you iterate. Pills show the alphabetical
// rank (1 = first), not zellij's internal position.
let sortedTabsCache = [];
let rankByTabId = new Map();
// Shortcuts from web_client config (via SetConfig): tab_bar_toggle_shortcut
// and switch_tab_shortcut. Defaults are set in initTabs.
let sidebarShortcut = null;
let switchTabShortcut = null;
let searchTabShortcut = null;
let newTabShortcut = null;
let renameTabShortcut = null;

function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function refreshSortCache() {
    sortedTabsCache = [...tabs].sort((a, b) => naturalCompare(a.name, b.name));
    rankByTabId = new Map();
    sortedTabsCache.forEach((tab, i) => rankByTabId.set(tab.tabId, i + 1));
}

function sortedTabs() {
    return sortedTabsCache;
}

// 1-based alphabetical rank for display; falls back to zellij position when
// the session predates stable tab ids (every tab_id is 0, ranks collapse).
function rankOf(tab) {
    const rank = rankByTabId.get(tab.tabId);
    return typeof rank === "number" ? rank : tab.position + 1;
}

// Parse a config shortcut like "Alt s", "Alt Tab", "Ctrl Shift b" into
// modifier flags plus a KeyboardEvent.code-style key. Returns null on
// unparseable input.
function parseShortcut(shortcut) {
    if (typeof shortcut !== "string" || !shortcut.trim()) {
        return null;
    }
    const parsed = { alt: false, ctrl: false, shift: false, meta: false, code: null };
    for (const part of shortcut.trim().split(/[\s+]+/)) {
        const lower = part.toLowerCase();
        if (lower === "alt") parsed.alt = true;
        else if (lower === "ctrl" || lower === "control") parsed.ctrl = true;
        else if (lower === "shift") parsed.shift = true;
        else if (lower === "meta" || lower === "cmd" || lower === "super") parsed.meta = true;
        else if (lower === "tab") parsed.code = "Tab";
        else if (/^[a-z]$/.test(lower)) parsed.code = "Key" + lower.toUpperCase();
        else if (/^[0-9]$/.test(lower)) parsed.code = "Digit" + lower;
        else return null;
    }
    return parsed.code ? parsed : null;
}

// ignoreShift lets a shift-less switch shortcut double as its own
// reverse-direction binding (Alt+Tab / Alt+Shift+Tab).
function eventMatchesShortcut(event, shortcut, ignoreShift) {
    return (
        shortcut &&
        event.altKey === shortcut.alt &&
        event.ctrlKey === shortcut.ctrl &&
        (ignoreShift || event.shiftKey === shortcut.shift) &&
        event.metaKey === shortcut.meta &&
        event.code === shortcut.code
    );
}

function parseConfigShortcut(shortcut, optionName, fallback) {
    if (shortcut === undefined || shortcut === null) {
        return fallback;
    }
    const parsed = parseShortcut(shortcut);
    if (parsed) {
        return parsed;
    }
    console.error(`Unparseable web_client ${optionName}: "${shortcut}"`);
    return fallback;
}

// Apply the tab-bar options carried by the SetConfig control message
// (web_client { tab_bar_toggle_shortcut / tab_bar_position / tab_bar_opacity }).
export function applyTabBarConfig(config) {
    sidebarShortcut = parseConfigShortcut(
        config.tab_bar_toggle_shortcut,
        "tab_bar_toggle_shortcut",
        sidebarShortcut
    );
    switchTabShortcut = parseConfigShortcut(
        config.switch_tab_shortcut,
        "switch_tab_shortcut",
        switchTabShortcut
    );
    searchTabShortcut = parseConfigShortcut(
        config.search_tab_shortcut,
        "search_tab_shortcut",
        searchTabShortcut
    );
    newTabShortcut = parseConfigShortcut(
        config.new_tab_shortcut,
        "new_tab_shortcut",
        newTabShortcut
    );
    renameTabShortcut = parseConfigShortcut(
        config.rename_tab_shortcut,
        "rename_tab_shortcut",
        renameTabShortcut
    );
    document.body.classList.toggle("tab-bar-top", config.tab_bar_position === "top");
    const opacity = config.tab_bar_opacity;
    document.documentElement.style.setProperty(
        "--zj-tab-bar-alpha",
        typeof opacity === "number"
            ? String(Math.min(Math.max(opacity, 0), 1))
            : "1"
    );
    // position affects whether the bar takes layout space (left) or overlays (top)
    requestTerminalRefit();
}

function sendPayload(payload) {
    if (!ext) {
        return;
    }
    switch (payload.type) {
        case "GoToTab":
            ext.pipe("web:go_to_tab", String(payload.index));
            break;
        case "CloseTab":
            ext.pipe("web:close_tab", String(payload.tab_id));
            break;
        case "RenameTab":
            ext.pipe("web:rename_tab", payload.tab_id + ":" + payload.name);
            break;
        case "NewTab":
            ext.pipe("web:new_tab", "");
            break;
        default:
            break;
    }
}

function refocusTerminal() {
    const helperTextarea = document.querySelector(
        "#terminal textarea.xterm-helper-textarea"
    );
    if (helperTextarea) {
        helperTextarea.focus();
    }
}

// The resize handler in websockets.js listens for this and refits the
// terminal grid to the space left over after the sidebar.
function requestTerminalRefit() {
    window.dispatchEvent(new CustomEvent("zellij:rendering-resize"));
}

// Tabs named with "/" separators ("upstream/rust/cuda") render as nested
// folders derived purely from the name — no stored grouping state. Only the
// collapse set is persisted (per session, per browser); losing it is
// harmless.
function currentSessionName() {
    return decodeURIComponent(location.pathname.split("/").pop() || "");
}

function collapsedGroupsKey() {
    return "zellij:tab-groups-collapsed:" + currentSessionName();
}

let collapsedGroups = null; // lazily loaded Set of group paths

function loadCollapsedGroups() {
    if (collapsedGroups) {
        return;
    }
    collapsedGroups = new Set();
    try {
        const raw = localStorage.getItem(collapsedGroupsKey());
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) {
            collapsedGroups = new Set(parsed);
        }
    } catch (e) {}
}

function toggleGroupCollapsed(path) {
    loadCollapsedGroups();
    if (collapsedGroups.has(path)) {
        collapsedGroups.delete(path);
    } else {
        collapsedGroups.add(path);
    }
    try {
        localStorage.setItem(
            collapsedGroupsKey(),
            JSON.stringify([...collapsedGroups])
        );
    } catch (e) {}
    renderTabs();
}

// Path-keyed tree. Each node may hold a tab (a tab whose full name is exactly
// this path) AND children — so "gst/upstream" can be a real switchable tab
// that also parents "gst/upstream/cuda-rs". `tabs` is an array only to keep
// exact-duplicate names (two tabs both named "gst/upstream") from colliding.
function buildTabTree() {
    const makeNode = (name, path) => ({
        name,
        path,
        tabs: [],
        children: new Map(),
    });
    const root = makeNode("", "");
    for (const tab of sortedTabs()) {
        const segments = tab.name
            .split("/")
            .map((s) => s.trim())
            .filter(Boolean);
        if (!segments.length) {
            segments.push(tab.name); // e.g. a tab literally named "/"
        }
        let node = root;
        let path = "";
        for (const segment of segments) {
            path = path ? `${path}/${segment}` : segment;
            let child = node.children.get(segment);
            if (!child) {
                child = makeNode(segment, path);
                node.children.set(segment, child);
            }
            node = child;
        }
        node.tabs.push(tab);
    }
    return root;
}

// Tabs strictly nested below this node (excludes the node's own tab), for the
// folder count badge.
function childTabCount(node) {
    let count = 0;
    for (const child of node.children.values()) {
        count += child.tabs.length + childTabCount(child);
    }
    return count;
}

function nodeHasActive(node) {
    if (node.tabs.some((tab) => tab.active)) {
        return true;
    }
    for (const child of node.children.values()) {
        if (nodeHasActive(child)) {
            return true;
        }
    }
    return false;
}

function buildTabItem(tab, depth, label) {
    const item = document.createElement("div");
    item.className = "tab-item" + (tab.active ? " active" : "");
    item.title = tab.name;
    if (typeof tab.tabId === "number") {
        item.dataset.tabId = String(tab.tabId);
    }
    if (depth > 0) {
        item.style.marginLeft = `${depth * 14}px`;
    }

    const num = document.createElement("span");
    num.className = "tab-item-num";
    num.textContent = String(rankOf(tab));
    item.appendChild(num);

    const name = document.createElement("span");
    name.className = "tab-item-name";
    name.textContent = label;
    item.appendChild(name);

    if (tab.hasBell) {
        const bell = document.createElement("span");
        bell.className = "tab-item-bell";
        bell.title = "Bell";
        item.appendChild(bell);
    }

    if (tab.paneCount > 1) {
        const count = document.createElement("span");
        count.className = "tab-item-count";
        count.textContent = tab.paneCount;
        count.title = `${tab.paneCount} panes`;
        item.appendChild(count);
    }

    if (tabsHaveStableIds()) {
        const rename = document.createElement("span");
        rename.className = "tab-item-rename";
        rename.textContent = "✎";
        rename.title = "Rename tab";
        rename.addEventListener("click", (event) => {
            event.stopPropagation();
            startTabRename(item, name, tab);
        });
        item.appendChild(rename);
    }

    const close = document.createElement("span");
    close.className = "tab-item-close";
    close.textContent = "×";
    close.title = "Close tab";
    close.addEventListener("click", (event) => {
        event.stopPropagation();
        sendPayload({ type: "CloseTab", tab_id: tab.tabId });
        refocusTerminal();
    });
    item.appendChild(close);

    item.addEventListener("click", () => {
        if (!tab.active) {
            sendPayload({ type: "GoToTab", index: tab.position + 1 });
        }
        refocusTerminal();
    });

    makeTabDraggable(item, tab);
    // Dropping onto a pill moves the dragged tab into the SAME folder as this
    // one (its parent path), a natural "put it next to this" gesture.
    makeFolderDropTarget(item, tabParentPath(tab.name));
    return item;
}

// --- drag & drop: move a tab between name-derived folders ---
// Folders are just "/"-separated name prefixes, so "moving" a tab into a
// folder is a rename to <folderPath>/<leaf>. Pure web-client, via RenameTab.

function tabLeafName(name) {
    const segs = name.split("/").map((s) => s.trim()).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : name;
}

function tabParentPath(name) {
    const segs = name.split("/").map((s) => s.trim()).filter(Boolean);
    return segs.slice(0, -1).join("/");
}

// Move a single tab under folderPath ("" = top level), keeping its leaf name.
// Only this tab is renamed — nested tabs that happen to share its prefix are
// independent and stay put.
function moveTabToFolderPath(tabId, folderPath) {
    const tab = tabs.find((t) => t.tabId === tabId);
    if (!tab) {
        return;
    }
    const leaf = tabLeafName(tab.name);
    const newName = folderPath ? `${folderPath}/${leaf}` : leaf;
    if (newName === tab.name) {
        return;
    }
    sendPayload({ type: "RenameTab", tab_id: tabId, name: newName });
    tab.name = newName; // optimistic; the server's TabUpdate confirms
    refreshSortCache();
    renderTabs();
}

const DRAG_TAB_MIME = "application/zellij-tab";

function makeTabDraggable(el, tab) {
    if (!tabsHaveStableIds()) {
        return;
    }
    el.draggable = true;
    el.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData(DRAG_TAB_MIME, String(tab.tabId));
        event.dataTransfer.effectAllowed = "move";
        el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
}

// Make `el` accept a dropped tab, moving it under `folderPath`.
function makeFolderDropTarget(el, folderPath) {
    el.addEventListener("dragover", (event) => {
        if (!event.dataTransfer.types.includes(DRAG_TAB_MIME)) {
            return;
        }
        event.preventDefault();
        // let the innermost (folder-row) target own the highlight, not the
        // list background it sits inside
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (event) => {
        const raw = event.dataTransfer.getData(DRAG_TAB_MIME);
        el.classList.remove("drop-target");
        if (!raw) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        moveTabToFolderPath(Number(raw), folderPath);
    });
}

// Sessions from older builds decode every tab_id as 0 (proto3 default);
// require unique numeric ids before offering id-keyed features like rename.
function tabsHaveStableIds() {
    return (
        tabs.every((tab) => typeof tab.tabId === "number") &&
        new Set(tabs.map((tab) => tab.tabId)).size === tabs.length
    );
}

// Inline rename, prefilled with the current full name (edit, don't retype —
// names carry the folder structure). Enter/blur commits, Esc cancels.
function startTabRename(item, nameEl, tab) {
    // If the bar is hidden the editor would be invisible; reveal it as an
    // overlay and keep it up until the edit finishes.
    beginEditReveal();
    const input = document.createElement("input");
    input.className = "tab-item-rename-input";
    input.value = tab.name;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    // freeze list rebuilds (from server TabUpdates) while editing
    renamingTabId = tab.tabId;
    const finish = () => {
        renamingTabId = null;
        renderPending = false;
        endEditReveal();
        refreshSortCache();
        renderTabs();
    };
    const commit = () => {
        const value = input.value.trim();
        if (value && value !== tab.name) {
            sendPayload({ type: "RenameTab", tab_id: tab.tabId, name: value });
            tab.name = value; // optimistic; the server's TabUpdate confirms
        }
        finish();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
            input.blur();
        } else if (event.key === "Escape") {
            input.removeEventListener("blur", commit);
            finish();
            refocusTerminal();
        }
    });
    input.addEventListener("keyup", (event) => event.stopPropagation());
    input.addEventListener("keypress", (event) => event.stopPropagation());
    // the pill's click handler would switch tabs; the sidebar's mousedown
    // preventDefault would stop the input from receiving focus
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());
}

// A folder row. If `folderTab` is set the row is also that tab (switch on
// label click, shows active/number/bell/rename/close); the chevron always
// toggles collapse. Without a folderTab it's a plain folder.
function buildFolderRow(node, depth, folderTab) {
    const collapsed = collapsedGroups.has(node.path);
    const row = document.createElement("div");
    const isActiveTab = folderTab && folderTab.active;
    const collapsedHoldsActive = collapsed && nodeHasActive(node);
    row.className =
        "tab-group-row" +
        (folderTab ? " tab-group-tab" : "") +
        (isActiveTab || collapsedHoldsActive ? " active" : "");
    if (depth > 0) {
        row.style.marginLeft = `${depth * 14}px`;
    }
    row.title = folderTab ? folderTab.name : node.path;
    if (folderTab && typeof folderTab.tabId === "number") {
        row.dataset.tabId = String(folderTab.tabId);
    }

    const chevron = document.createElement("span");
    chevron.className = "tab-group-chevron";
    chevron.textContent = collapsed ? "▸" : "▾";
    chevron.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleGroupCollapsed(node.path);
    });
    row.appendChild(chevron);

    if (folderTab) {
        const num = document.createElement("span");
        num.className = "tab-item-num";
        num.textContent = String(rankOf(folderTab));
        row.appendChild(num);
    }

    const label = document.createElement("span");
    label.className = "tab-group-name";
    label.textContent = node.name;
    row.appendChild(label);

    if (folderTab && folderTab.hasBell) {
        const bell = document.createElement("span");
        bell.className = "tab-item-bell";
        bell.title = "Bell";
        row.appendChild(bell);
    }

    const count = document.createElement("span");
    count.className = "tab-group-count";
    count.textContent = String(childTabCount(node));
    count.title = `${childTabCount(node)} nested`;
    row.appendChild(count);

    if (folderTab && tabsHaveStableIds()) {
        const rename = document.createElement("span");
        rename.className = "tab-item-rename";
        rename.textContent = "✎";
        rename.title = "Rename tab";
        rename.addEventListener("click", (event) => {
            event.stopPropagation();
            startTabRename(row, label, folderTab);
        });
        row.appendChild(rename);
    }

    if (folderTab) {
        const close = document.createElement("span");
        close.className = "tab-item-close";
        close.textContent = "×";
        close.title = "Close tab";
        close.addEventListener("click", (event) => {
            event.stopPropagation();
            sendPayload({ type: "CloseTab", tab_id: folderTab.tabId });
            refocusTerminal();
        });
        row.appendChild(close);
    }

    // Row click: switch to the folder-tab if there is one, else just collapse.
    row.addEventListener("click", () => {
        if (folderTab) {
            if (!folderTab.active) {
                sendPayload({ type: "GoToTab", index: folderTab.position + 1 });
            }
            refocusTerminal();
        } else {
            toggleGroupCollapsed(node.path);
        }
    });

    // Dropping a tab on this row moves it INTO this folder (node.path).
    makeFolderDropTarget(row, node.path);
    // A folder-tab is itself a tab, so it can also be dragged elsewhere.
    if (folderTab) {
        makeTabDraggable(row, folderTab);
    }
    return row;
}

// Render a node's children in alphabetical order. A child with its own
// children is a folder (or folder-tab if it also has tabs); a childless child
// just renders its tab(s) as pills.
function renderTreeNode(node, list, depth) {
    const children = [...node.children.values()].sort((a, b) =>
        naturalCompare(a.name, b.name)
    );
    for (const child of children) {
        const hasChildren = child.children.size > 0;
        if (!hasChildren) {
            // pure leaf: one pill per tab sharing this exact name
            for (const tab of child.tabs) {
                list.appendChild(buildTabItem(tab, depth, child.name));
            }
            continue;
        }
        // folder (foldable). If it also has a tab, the row doubles as a
        // switchable tab; extra same-named tabs render as pills underneath.
        const folderTab = child.tabs.length ? child.tabs[0] : null;
        const extraTabs = child.tabs.slice(folderTab ? 1 : 0);
        list.appendChild(buildFolderRow(child, depth, folderTab));
        if (!collapsedGroups.has(child.path)) {
            for (const tab of extraTabs) {
                list.appendChild(buildTabItem(tab, depth + 1, child.name));
            }
            renderTreeNode(child, list, depth + 1);
        }
    }
}

// While an inline rename input is open, a server TabUpdate must not rebuild
// the list — replaceChildren() would destroy the focused input mid-edit
// (name appears to blank, typing is lost). Defer the render until commit.
let renamingTabId = null;
let renderPending = false;

function renderTabs() {
    if (renamingTabId !== null) {
        renderPending = true;
        return;
    }
    const list = document.getElementById("tab-sidebar-list");
    if (!list) {
        return;
    }
    list.replaceChildren();
    if (document.body.classList.contains("tab-bar-top")) {
        // the horizontal strip stays flat
        for (const tab of sortedTabs()) {
            list.appendChild(buildTabItem(tab, 0, tab.name));
        }
    } else {
        loadCollapsedGroups();
        renderTreeNode(buildTabTree(), list, 0);
    }
    updateToggleIndicator();
}

// The chip fades to near-invisible after a few seconds of no tab activity so
// it stops covering terminal content; hovering it or any tab change wakes it.
let chipIdleTimer = null;

// On touch devices there's no hover to wake a faded chip, so the idle-fade is
// disabled there (see body.no-hover in CSS) and the toggle becomes a
// full-width bottom bar instead of a small floating chip.
const HAS_HOVER =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover)").matches;

function wakeChip() {
    const toggle = document.getElementById("tab-sidebar-toggle");
    if (!toggle || !HAS_HOVER) {
        return;
    }
    toggle.classList.remove("idle");
    if (chipIdleTimer) {
        clearTimeout(chipIdleTimer);
    }
    chipIdleTimer = setTimeout(() => toggle.classList.add("idle"), 3000);
}

// When the bar is hidden, the toggle chip doubles as a compact indicator of
// the focused tab (its name, truncated by CSS).
function updateToggleIndicator() {
    const sidebar = document.getElementById("tab-sidebar");
    const toggle = document.getElementById("tab-sidebar-toggle");
    const name = document.getElementById("tab-sidebar-toggle-name");
    if (!sidebar || !toggle || !name) {
        return;
    }
    const activeTab = tabs.find((tab) => tab.active);
    name.textContent = activeTab ? activeTab.name : "";
    toggle.classList.toggle("show-name", barMode === "hidden" && !!activeTab);
    toggle.title = barMode === "pinned" ? "Unpin tab bar" : "Pin tab bar";
    wakeChip();
}

// Set when the user asks for a new tab from the HTML bar and wants to name it
// immediately: the server creates the tab asynchronously, so we remember the
// tab_ids that existed before and open the rename editor on whichever new one
// appears in the next TabUpdate.
let pendingNameTabIds = null;

export function updateTabs(newTabs) {
    const prevIds = new Set(tabs.map((t) => t.tabId));
    tabs = Array.isArray(newTabs) ? newTabs : [];
    refreshSortCache();
    // Track MRU from the server's authoritative active tab, but not while a
    // cycle is in progress (the frozen snapshot owns ordering until release).
    if (!mruCycle) {
        const active = tabs.find((t) => t.active);
        if (active) {
            noteActiveTab(active.tabId);
        }
    }
    // prune ids for tabs that no longer exist
    const live = new Set(tabs.map((t) => t.tabId));
    mruTabIds = mruTabIds.filter((id) => live.has(id));
    renderTabs();
    if (pendingNameTabIds) {
        const fresh = tabs.find(
            (t) => !pendingNameTabIds.has(t.tabId) && !prevIds.has(t.tabId)
        );
        if (fresh) {
            pendingNameTabIds = null;
            openRenameForTabId(fresh.tabId);
        }
    }
}

// Open the inline rename editor on an already-rendered tab, prefilled. Used
// after creating a tab (empty name) and could back any "rename tab N" flow.
function openRenameForTabId(tabId) {
    const tab = tabs.find((t) => t.tabId === tabId);
    if (!tab) {
        return;
    }
    const row = document.querySelector(
        `#tab-sidebar-list .tab-item[data-tab-id="${tabId}"], ` +
            `#tab-sidebar-list .tab-group-row[data-tab-id="${tabId}"]`
    );
    if (!row) {
        return;
    }
    const nameEl = row.querySelector(".tab-item-name, .tab-group-name");
    if (nameEl) {
        startTabRename(row, nameEl, tab);
    }
}

function requestNewTabAndName() {
    pendingNameTabIds = new Set(tabs.map((t) => t.tabId));
    sendPayload({ type: "NewTab" });
}

// Open the rename editor on the currently active tab (Alt+r); reveals the bar
// if hidden. Pure web-client rename — never touches zellij's native mode.
function renameActiveTab() {
    if (!tabsHaveStableIds()) {
        return;
    }
    const active = tabs.find((t) => t.active);
    if (active) {
        openRenameForTabId(active.tabId);
    }
}

function applyBarMode(mode) {
    const sidebar = document.getElementById("tab-sidebar");
    if (!sidebar) {
        return;
    }
    // a deliberate mode change overrides any in-progress transient reveal
    if (switchRevealTimer) {
        clearTimeout(switchRevealTimer);
        switchRevealTimer = null;
    }
    switchRevealActive = false;
    barMode = mode;
    localStorage.setItem(MODE_KEY, mode);
    sidebar.classList.toggle("collapsed", mode === "hidden");
    document.body.classList.toggle("tab-bar-overlay", mode === "overlay");
    updateToggleIndicator();
    requestTerminalRefit();
    refocusTerminal();
}

// Alt+s: quick peek. Hidden gets a floating overlay; any visible bar hides.
export function toggleSidebar() {
    applyBarMode(barMode === "hidden" ? "overlay" : "hidden");
}

// Chip click: pin/unpin. A peeked overlay is promoted to pinned.
function togglePin() {
    applyBarMode(barMode === "pinned" ? "hidden" : "pinned");
}

// Switching cycles in the tab bar itself rather than a separate overlay: if
// the bar is hidden, reveal it transiently as a floating OVERLAY while the
// switch modifier is held (no terminal reflow — it floats over the grid), then
// re-hide on release. This keeps a single visual model for switching — the bar
// — instead of a competing HUD.
let switchRevealActive = false;
let switchRevealTimer = null;
// True from the moment a switch (cycle or digit jump) is initiated until the
// switch modifier is released. Only during this window do Alt+arrows walk
// tabs; otherwise they pass through to the terminal (pane navigation).
let switchInProgress = false;

// MRU (most-recently-used) tab order, as tab ids, most-recent first. Alt+Tab
// walks this like an OS app switcher: the first press jumps to the last-used
// tab, further presses (modifier held) go further back. Updated on real tab
// activations, but FROZEN during a cycle so the order doesn't shift under you.
let mruTabIds = [];
let mruCycle = null; // { order: [ids...], index } while a cycle is in progress

// Record a tab activation in the MRU list (unless we're mid-cycle, where the
// snapshot is authoritative and gets committed on release).
function noteActiveTab(tabId) {
    if (typeof tabId !== "number") {
        return;
    }
    mruTabIds = [tabId, ...mruTabIds.filter((id) => id !== tabId)];
}

// A sticky reveal used while an inline editor (rename / new-tab name) is open:
// like the switch reveal but it stays up (no modifier to release) until the
// edit finishes.
let editRevealActive = false;

function beginEditReveal() {
    const sidebar = document.getElementById("tab-sidebar");
    if (sidebar && barMode === "hidden" && !editRevealActive) {
        editRevealActive = true;
        document.body.classList.add("tab-bar-overlay");
        sidebar.classList.remove("collapsed");
    }
}

function endEditReveal() {
    if (!editRevealActive) {
        return;
    }
    editRevealActive = false;
    const sidebar = document.getElementById("tab-sidebar");
    if (sidebar && barMode === "hidden") {
        document.body.classList.remove("tab-bar-overlay");
        sidebar.classList.add("collapsed");
    }
}

function beginSwitchReveal() {
    switchInProgress = true;
    const sidebar = document.getElementById("tab-sidebar");
    if (sidebar && barMode === "hidden" && !switchRevealActive) {
        switchRevealActive = true;
        // present as a floating overlay: no layout space taken, so the
        // terminal never reflows while cycling
        document.body.classList.add("tab-bar-overlay");
        sidebar.classList.remove("collapsed");
    }
    // Modifier-driven switches end on keyup/blur; a modifier-less shortcut, or
    // a touch device (where the sticky-modifier synthetic keydown has no
    // keyup), ends on a short idle instead. A 30s backstop guards the held-key
    // case against a lost keyup.
    const heldModifier =
        HAS_HOVER &&
        switchTabShortcut &&
        (switchTabShortcut.alt || switchTabShortcut.ctrl || switchTabShortcut.meta);
    if (switchRevealTimer) {
        clearTimeout(switchRevealTimer);
        switchRevealTimer = null;
    }
    if (switchRevealActive) {
        switchRevealTimer = setTimeout(
            endSwitchReveal,
            heldModifier ? 30000 : 1200
        );
    }
    scrollActivePillIntoView();
}

function scrollActivePillIntoView() {
    const active = document.querySelector(
        "#tab-sidebar-list .tab-item.active, #tab-sidebar-list .tab-group-row.active"
    );
    if (active && typeof active.scrollIntoView === "function") {
        active.scrollIntoView({ block: "nearest" });
    }
}

function endSwitchReveal() {
    switchInProgress = false;
    endSwitchCycle();
    if (switchRevealTimer) {
        clearTimeout(switchRevealTimer);
        switchRevealTimer = null;
    }
    if (!switchRevealActive) {
        return;
    }
    switchRevealActive = false;
    const sidebar = document.getElementById("tab-sidebar");
    if (sidebar && barMode === "hidden") {
        // restore the hidden mode's non-overlay presentation
        document.body.classList.remove("tab-bar-overlay");
        sidebar.classList.add("collapsed");
    }
}

// Fuzzy tab search palette (Ctrl+K by default): subsequence match with
// bonuses for consecutive runs and word starts, penalty for length.
function fuzzyScore(query, text) {
    if (!query) {
        return 0;
    }
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let score = 0;
    let searchFrom = 0;
    let previousMatch = -2;
    for (const ch of q) {
        const idx = t.indexOf(ch, searchFrom);
        if (idx === -1) {
            return -Infinity;
        }
        score += 1;
        if (idx === previousMatch + 1) {
            score += 2;
        }
        if (idx === 0 || /[\s\-_./:#]/.test(t[idx - 1])) {
            score += 3;
        }
        previousMatch = idx;
        searchFrom = idx + 1;
    }
    return score - t.length * 0.01;
}

let paletteMatches = [];
let paletteSelectedIndex = 0;

function paletteIsOpen() {
    const palette = document.getElementById("tab-palette");
    return !!palette && palette.classList.contains("visible");
}

function renderPalette(query, selectActive) {
    const list = document.getElementById("tab-palette-list");
    if (!list) {
        return;
    }
    // Sort by fuzzy score, then alphabetically so an empty query (all equal
    // score) lists tabs in the same order as everywhere else.
    paletteMatches = sortedTabs()
        .map((tab) => ({ tab, score: fuzzyScore(query, tab.name) }))
        .filter((match) => match.score > -Infinity)
        .sort((a, b) => b.score - a.score)
        .map((match) => match.tab);
    if (selectActive) {
        // preselect the current tab (used when opening with an empty query)
        const activeIdx = paletteMatches.findIndex((tab) => tab.active);
        paletteSelectedIndex = activeIdx === -1 ? 0 : activeIdx;
    } else if (paletteSelectedIndex >= paletteMatches.length) {
        paletteSelectedIndex = 0;
    }
    list.replaceChildren();
    if (!paletteMatches.length) {
        const empty = document.createElement("div");
        empty.className = "tab-palette-empty";
        empty.textContent = "No matching tab";
        list.appendChild(empty);
        return;
    }
    paletteMatches.forEach((tab, i) => {
        const row = document.createElement("div");
        row.className =
            "tab-palette-item" + (i === paletteSelectedIndex ? " selected" : "");
        const num = document.createElement("span");
        num.className = "tab-palette-num";
        num.textContent = String(rankOf(tab));
        row.appendChild(num);
        // mirror the sidebar's name-derived folders: leaf name up front,
        // the folder path as a dim tag (matching still runs on the full name)
        const segments = tab.name
            .split("/")
            .map((s) => s.trim())
            .filter(Boolean);
        const name = document.createElement("span");
        name.className = "tab-palette-name";
        name.textContent = segments.length > 1 ? segments[segments.length - 1] : tab.name;
        row.appendChild(name);
        if (segments.length > 1) {
            const folderTag = document.createElement("span");
            folderTag.className = "tab-palette-folder";
            folderTag.textContent = segments.slice(0, -1).join(" / ");
            row.appendChild(folderTag);
        }
        // mousedown would blur the input (closing the palette) before click
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => commitPaletteSelection(i));
        list.appendChild(row);
    });
    const selectedRow = list.children[paletteSelectedIndex];
    if (selectedRow && typeof selectedRow.scrollIntoView === "function") {
        selectedRow.scrollIntoView({ block: "nearest" });
    }
}

function openTabPalette() {
    const palette = document.getElementById("tab-palette");
    const input = document.getElementById("tab-palette-input");
    if (!palette || !input) {
        return;
    }
    endSwitchReveal();
    paletteSelectedIndex = 0;
    input.value = "";
    renderPalette("", true); // preselect the current tab
    palette.classList.add("visible");
    input.focus();
}

function closeTabPalette(refocus) {
    const palette = document.getElementById("tab-palette");
    if (!palette || !palette.classList.contains("visible")) {
        return;
    }
    palette.classList.remove("visible");
    if (refocus) {
        refocusTerminal();
    }
}

function commitPaletteSelection(index) {
    const target = paletteMatches[index];
    closeTabPalette(true);
    if (!target) {
        return;
    }
    if (!target.active) {
        sendPayload({ type: "GoToTab", index: target.position + 1 });
        tabs.forEach((tab) => (tab.active = tab === target));
        renderTabs();
    }
}

function goToTabNumber(number) {
    // `number` is the alphabetical rank shown on the pill, not zellij's position
    const ordered = sortedTabs();
    const target = ordered[number - 1];
    if (!target) {
        return;
    }
    if (!target.active) {
        sendPayload({ type: "GoToTab", index: target.position + 1 });
        tabs.forEach((tab) => (tab.active = tab === target));
        renderTabs();
    }
    // reveal the bar (if hidden) so the jump is visible, then it re-hides
    beginSwitchReveal();
}

function switchTab(direction) {
    if (!tabs.length) {
        return;
    }
    // On the first press of a cycle, freeze an MRU snapshot: the currently
    // active tab first, then the rest in MRU order, then any never-visited
    // tabs in alphabetical order. Walking this makes the 1st Tab land on the
    // last-used tab (OS app-switcher feel), and it doesn't reshuffle mid-cycle.
    if (!mruCycle) {
        const active = tabs.find((t) => t.active);
        const byId = new Map(tabs.map((t) => [t.tabId, t]));
        const order = [];
        const seen = new Set();
        const push = (id) => {
            if (byId.has(id) && !seen.has(id)) {
                seen.add(id);
                order.push(id);
            }
        };
        if (active) {
            push(active.tabId);
        }
        mruTabIds.forEach(push);
        // tabs never recorded in MRU yet — append alphabetically
        sortedTabs().forEach((t) => push(t.tabId));
        mruCycle = { order, index: 0 };
    }
    const n = mruCycle.order.length;
    mruCycle.index = ((mruCycle.index + direction) % n + n) % n;
    const nextId = mruCycle.order[mruCycle.index];
    const next = tabs.find((t) => t.tabId === nextId);
    if (!next) {
        return;
    }
    sendPayload({ type: "GoToTab", index: next.position + 1 });
    // optimistic, so rapid presses keep cycling before the server echoes back
    tabs.forEach((tab) => (tab.active = tab === next));
    renderTabs();
    beginSwitchReveal();
}

// End of a cycle (modifier released): commit the landed tab to the MRU front
// and clear the frozen snapshot so the next Alt+Tab re-snapshots.
function endSwitchCycle() {
    if (mruCycle) {
        const landed = tabs.find((t) => t.active);
        if (landed) {
            noteActiveTab(landed.tabId);
        }
        mruCycle = null;
    }
}

export function initTabs(wsControlGetter, webClientIdGetter, sendAnsiKeyGetter) {
    getWsControl = wsControlGetter;
    getOwnWebClientId = webClientIdGetter;
    getSendAnsiKey = sendAnsiKeyGetter || null;

    const sidebar = document.getElementById("tab-sidebar");
    const toggle = document.getElementById("tab-sidebar-toggle");
    const newTabButton = document.getElementById("tab-sidebar-new-tab");
    if (!sidebar || !toggle || !newTabButton) {
        return;
    }

    const sessionLabel = document.getElementById("tab-sidebar-session");
    if (sessionLabel) {
        const sessionName = decodeURIComponent(
            location.pathname.split("/").pop() || ""
        );
        sessionLabel.textContent = sessionName;
    }

    // No-hover (touch/mobile): the toggle becomes a full-width bottom bar and
    // never idle-fades, so it's always an obvious, easily-tappable target.
    document.body.classList.toggle("no-hover", !HAS_HOVER);

    const savedMode = localStorage.getItem(MODE_KEY);
    applyBarMode(
        savedMode === "hidden" || savedMode === "overlay" || savedMode === "pinned"
            ? savedMode
            : "pinned"
    );

    // Keep clicks in the sidebar from stealing keyboard focus away from the
    // terminal in the first place — but NOT on tab pills/rows, where
    // preventDefault would also cancel the HTML5 drag we use to move tabs
    // between folders. Those elements refocus the terminal on click anyway.
    sidebar.addEventListener("mousedown", (event) => {
        if (event.target.closest(".tab-item, .tab-group-row")) {
            return;
        }
        event.preventDefault();
    });
    toggle.addEventListener("mousedown", (event) => event.preventDefault());

    // Dropping a tab on the list background (not on a folder) moves it to the
    // top level. Folder rows stopPropagation on their own drop, so this only
    // fires for empty space.
    const listEl = document.getElementById("tab-sidebar-list");
    if (listEl) {
        makeFolderDropTarget(listEl, "");
    }

    toggle.addEventListener("click", togglePin);
    toggle.addEventListener("mouseenter", wakeChip);

    // Defaults, unless SetConfig already delivered configured values
    if (!sidebarShortcut) {
        sidebarShortcut = parseShortcut("Alt s");
    }
    if (!switchTabShortcut) {
        // Touch has no OS app-switcher clash and no Super/Alt held-modifier
        // gesture, so Ctrl+Tab (armed via the extra-keys row) is the natural
        // default. On desktop: Alt+Tab is the OS app switcher on Linux/Windows
        // but free on macOS; Super/Meta+Tab is the least-contended elsewhere.
        if (!HAS_HOVER) {
            switchTabShortcut = parseShortcut("Ctrl Tab");
        } else {
            const isMac = /Mac|iPhone|iPad/.test(
                (navigator.userAgentData && navigator.userAgentData.platform) ||
                    navigator.platform ||
                    navigator.userAgent
            );
            switchTabShortcut = parseShortcut(isMac ? "Alt Tab" : "Super Tab");
        }
    }
    if (!searchTabShortcut) {
        searchTabShortcut = parseShortcut("Ctrl k");
    }

    // Capture phase on document so shortcuts fire before xterm's own key
    // handling and never reach the terminal.
    document.addEventListener(
        "keydown",
        (event) => {
            if (eventMatchesShortcut(event, searchTabShortcut, false)) {
                event.preventDefault();
                event.stopPropagation();
                if (paletteIsOpen()) {
                    closeTabPalette(true);
                } else {
                    openTabPalette();
                }
                return;
            }
            if (paletteIsOpen()) {
                // the palette input owns the keyboard while open
                return;
            }
            if (
                newTabShortcut &&
                eventMatchesShortcut(event, newTabShortcut, false)
            ) {
                event.preventDefault();
                event.stopPropagation();
                requestNewTabAndName();
                return;
            }
            if (
                renameTabShortcut &&
                eventMatchesShortcut(event, renameTabShortcut, false)
            ) {
                event.preventDefault();
                event.stopPropagation();
                renameActiveTab();
                return;
            }
            // Enter dismisses a bar that is only up as a transient/edit reveal.
            // Guard against firing while an inline editor is focused (there
            // Enter commits) — the editor's own handler owns that case.
            if (
                event.key === "Enter" &&
                (switchRevealActive || editRevealActive) &&
                renamingTabId === null &&
                !(document.activeElement &&
                    document.activeElement.tagName === "INPUT")
            ) {
                event.preventDefault();
                event.stopPropagation();
                endSwitchReveal();
                endEditReveal();
                return;
            }
            if (eventMatchesShortcut(event, sidebarShortcut, false)) {
                event.preventDefault();
                event.stopPropagation();
                toggleSidebar();
            } else if (
                sidebarShortcut &&
                !sidebarShortcut.shift &&
                event.shiftKey &&
                eventMatchesShortcut(event, sidebarShortcut, true)
            ) {
                // Shift + the peek shortcut pins/unpins, same as the chip
                event.preventDefault();
                event.stopPropagation();
                togglePin();
            } else if (
                switchTabShortcut &&
                eventMatchesShortcut(event, switchTabShortcut, !switchTabShortcut.shift)
            ) {
                event.preventDefault();
                event.stopPropagation();
                const backwards = !switchTabShortcut.shift && event.shiftKey;
                switchTab(backwards ? -1 : 1);
            } else if (
                switchTabShortcut &&
                (switchTabShortcut.alt ||
                    switchTabShortcut.ctrl ||
                    switchTabShortcut.meta) &&
                event.altKey === switchTabShortcut.alt &&
                event.ctrlKey === switchTabShortcut.ctrl &&
                event.metaKey === switchTabShortcut.meta &&
                !event.shiftKey &&
                /^Digit[1-9]$/.test(event.code)
            ) {
                // switch modifier + digit jumps straight to that tab number
                event.preventDefault();
                event.stopPropagation();
                goToTabNumber(Number(event.code.slice(5)));
            } else if (
                switchInProgress &&
                switchTabShortcut &&
                event.altKey === switchTabShortcut.alt &&
                event.ctrlKey === switchTabShortcut.ctrl &&
                event.metaKey === switchTabShortcut.meta &&
                (event.code === "ArrowDown" || event.code === "ArrowUp")
            ) {
                // Only WHILE cycling (a switch already in progress, modifier
                // still held) do arrows walk tabs. Otherwise Alt+arrows fall
                // through to the terminal so zellij navigates panes up/down.
                event.preventDefault();
                event.stopPropagation();
                switchTab(event.code === "ArrowDown" ? 1 : -1);
            }
        },
        { capture: true }
    );

    // Releasing the switch modifier ends the transient bar reveal, alt-tab
    // style; window blur is the fallback when the keyup gets lost.
    document.addEventListener(
        "keyup",
        (event) => {
            if (!switchTabShortcut) {
                return;
            }
            if (
                (switchTabShortcut.alt && event.key === "Alt") ||
                (switchTabShortcut.ctrl && event.key === "Control") ||
                (switchTabShortcut.meta && event.key === "Meta")
            ) {
                endSwitchReveal();
            }
        },
        { capture: true }
    );
    window.addEventListener("blur", endSwitchReveal);
    document.addEventListener("visibilitychange", endSwitchReveal);

    const paletteInput = document.getElementById("tab-palette-input");
    if (paletteInput) {
        paletteInput.addEventListener("keydown", (event) => {
            if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
                event.preventDefault();
                if (paletteMatches.length) {
                    paletteSelectedIndex =
                        (paletteSelectedIndex + 1) % paletteMatches.length;
                    renderPalette(paletteInput.value);
                }
            } else if (
                event.key === "ArrowUp" ||
                (event.ctrlKey && event.key === "p")
            ) {
                event.preventDefault();
                if (paletteMatches.length) {
                    paletteSelectedIndex =
                        (paletteSelectedIndex - 1 + paletteMatches.length) %
                        paletteMatches.length;
                    renderPalette(paletteInput.value);
                }
            } else if (event.key === "Enter") {
                event.preventDefault();
                commitPaletteSelection(paletteSelectedIndex);
            } else if (event.key === "Escape") {
                event.preventDefault();
                closeTabPalette(true);
            }
            // whatever happens, typing in the palette never reaches the
            // terminal or other document-level handlers
            event.stopPropagation();
        });
        paletteInput.addEventListener("keyup", (event) => event.stopPropagation());
        paletteInput.addEventListener("keypress", (event) =>
            event.stopPropagation()
        );
        paletteInput.addEventListener("input", () => {
            paletteSelectedIndex = 0;
            renderPalette(paletteInput.value);
        });
        // clicking elsewhere (e.g. the terminal) dismisses the palette
        paletteInput.addEventListener("blur", () => closeTabPalette(false));
    }

    newTabButton.addEventListener("click", () => {
        requestNewTabAndName();
    });

    requestTerminalRefit();
}

// ---------------------------------------------------------------------------
// Web-extension glue: DOM scaffold, CSS, and the companion pipe wiring.
//
// The core web client ships none of the tab-bar markup or CSS. On enable we
// build the scaffold (the same element ids tabs.js reads), inject the tab-bar
// stylesheet, and establish the `#app` flex layout by wrapping the existing
// `#terminal`, then hand off to the verbatim initTabs()/applyTabBarConfig().
// ---------------------------------------------------------------------------

let ext = null;
let scaffoldReady = false;

// The web-tabs default web_client tab-bar config: no configured shortcuts (so
// initTabs' built-in defaults stand), left-side bar, opaque.
const defaultConfig = {
    tab_bar_position: "left",
    tab_bar_opacity: 1,
};

// Build the DOM scaffold tabs.js expects (index.html lines 30-48 of web-tabs),
// wrapping the existing #terminal in an #app flex container. Idempotent.
function ensureScaffold() {
    if (scaffoldReady) {
        return;
    }
    injectStyles();

    const terminal = document.getElementById("terminal");
    // Wrap #terminal in an #app flex row so a pinned sidebar takes layout space
    // beside it (overlay/top modes float and don't need the flex space).
    let app = document.getElementById("app");
    if (!app) {
        app = document.createElement("div");
        app.id = "app";
        if (terminal && terminal.parentNode) {
            terminal.parentNode.insertBefore(app, terminal);
        } else {
            document.body.appendChild(app);
        }
    }

    // The bottom-left toggle chip (doubles as the active-tab indicator when the
    // bar is hidden, and as the full-width touch bar on no-hover devices).
    if (!document.getElementById("tab-sidebar-toggle")) {
        const toggle = document.createElement("button");
        toggle.id = "tab-sidebar-toggle";
        toggle.title = "Toggle tab bar";
        toggle.setAttribute("aria-label", "Toggle tab bar");
        const icon = document.createElement("span");
        icon.id = "tab-sidebar-toggle-icon";
        icon.innerHTML = "&#9776;";
        toggle.appendChild(icon);
        const name = document.createElement("span");
        name.id = "tab-sidebar-toggle-name";
        toggle.appendChild(name);
        document.body.appendChild(toggle);
    }

    // The sidebar nav: header/session, the tab list, the new-tab button.
    if (!document.getElementById("tab-sidebar")) {
        const nav = document.createElement("nav");
        nav.id = "tab-sidebar";

        const header = document.createElement("div");
        header.id = "tab-sidebar-header";
        const session = document.createElement("span");
        session.id = "tab-sidebar-session";
        header.appendChild(session);
        nav.appendChild(header);

        const list = document.createElement("div");
        list.id = "tab-sidebar-list";
        nav.appendChild(list);

        const newTab = document.createElement("button");
        newTab.id = "tab-sidebar-new-tab";
        newTab.innerHTML = "+&nbsp;&nbsp;New tab";
        nav.appendChild(newTab);

        app.appendChild(nav);
    }

    // #terminal is the flex sibling of the sidebar; make sure it lives in #app.
    if (terminal && terminal.parentNode !== app) {
        app.appendChild(terminal);
    }

    // The fuzzy-search palette (Ctrl+K). Lives outside #app (fixed-positioned).
    if (!document.getElementById("tab-palette")) {
        const palette = document.createElement("div");
        palette.id = "tab-palette";
        palette.setAttribute("aria-hidden", "true");
        const input = document.createElement("input");
        input.id = "tab-palette-input";
        input.type = "text";
        input.placeholder = "Switch to tab…";
        input.autocomplete = "off";
        input.spellcheck = false;
        palette.appendChild(input);
        const pList = document.createElement("div");
        pList.id = "tab-palette-list";
        palette.appendChild(pList);
        document.body.appendChild(palette);
    }

    scaffoldReady = true;
}

ext = registerWebExtension("web-tab-bar.wasm", {
    onEnabled() {
        ensureScaffold();
        initTabs(null, null, null);
        applyTabBarConfig(defaultConfig);
        // onEnabled fires once the frontend module is served over the browser's
        // control channel, i.e. after that channel is up. Ask the companion to
        // (re)send the tab list now: the TabUpdate it posted at enable time may
        // have been dropped because the control channel wasn't ready yet.
        if (ext) {
            ext.pipe("web:request_tabs", "");
        }
    },
    onReset() {
        tabs = [];
        refreshSortCache();
        if (scaffoldReady) {
            renderTabs();
        }
    },
    onMessage(payload) {
        let msg;
        try {
            msg = JSON.parse(payload);
        } catch (_) {
            return;
        }
        if (msg.kind === "tabs" && Array.isArray(msg.tabs)) {
            updateTabs(msg.tabs);
        } else if (msg.kind === "config" && msg.config) {
            applyTabBarConfig(msg.config);
        }
    },
});

// Tab-bar CSS: a verbatim copy of the web-tabs branch stylesheet
// (zellij-client/assets/style.css lines 50-634 — the `#app` flex layout,
// `#tab-sidebar*`, `#tab-palette*`, `.tab-item`, `.tab-group*`, `.folder*`,
// switcher, and the overlay/top/collapsed/no-hover mode variants). The base
// `:root`/`html,body` rules already live in the client stylesheet; only the
// `--zj-tab-bar-alpha` var is added here (the client lacks it). The Termux
// extra-keys row rules (`#extra-keys-row`, `.extra-key`) belong to the
// `web-extra-keys` companion and are intentionally omitted.
function injectStyles() {
    if (document.getElementById("zj-tab-bar-style")) {
        return;
    }
    const style = document.createElement("style");
    style.id = "zj-tab-bar-style";
    style.textContent = `
:root {
    /* web_client.tab_bar_opacity, applied to the bar's background only, so
       text stays legible over the terminal (frosted glass, not ghosting). */
    --zj-tab-bar-alpha: 1;
}

#app {
    display: flex;
    /* subtract the floating extra-keys row's reserved height (0 when hidden)
       so the terminal never sits under it */
    height: calc(var(--dynamic-vh, 100vh) - var(--zj-extra-keys-height, 0px));
    width: var(--dynamic-vw, 100vw);
    overflow: hidden;
}

#terminal {
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    margin: 0;
    overflow: hidden;
    overscroll-behavior: contain;
    touch-action: pan-y;
}

#tab-sidebar {
    flex: 0 0 232px;
    display: flex;
    flex-direction: column;
    background: var(--zj-surface);
    color: var(--zj-fg);
    font-family: var(--zj-ui-font);
    user-select: none;
    overflow: hidden;
}

/* Translucency only applies in the floating modes (overlay / top strip);
   a pinned bar has nothing behind it, so it stays solid. */
body.tab-bar-overlay #tab-sidebar,
body.tab-bar-top #tab-sidebar {
    background: color-mix(
        in srgb,
        var(--zj-surface) calc(var(--zj-tab-bar-alpha) * 100%),
        transparent
    );
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
}

#tab-sidebar.collapsed {
    display: none;
}

#tab-sidebar-header {
    padding: 14px 14px 10px 14px;
    min-height: 22px;
    display: flex;
    align-items: center;
}

#tab-sidebar-session {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--zj-text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

#tab-sidebar-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.tab-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    transition: background 140ms ease;
}

.tab-item:hover {
    background: var(--zj-surface-hover);
}

.tab-item.active {
    background: var(--zj-surface-active);
}

/* Drag & drop: move a tab between name-derived folders */
.tab-item.dragging,
.tab-group-row.dragging {
    opacity: 0.4;
}

.tab-item.drop-target,
.tab-group-row.drop-target,
#tab-sidebar-list.drop-target {
    outline: 2px solid color-mix(in srgb, var(--zj-fg) 45%, transparent);
    outline-offset: -2px;
    background: var(--zj-surface-hover);
}

/* Name-derived folder rows (tabs named "group/name") */
.tab-group-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    margin-top: 4px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--zj-text-dim);
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
}

.tab-group-row:hover {
    background: var(--zj-surface-hover);
    color: var(--zj-fg);
}

/* collapsed group holding the active tab */
.tab-group-row.active {
    background: var(--zj-surface-active);
    color: var(--zj-fg);
}

.tab-group-chevron {
    flex: none;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    border-radius: 4px;
    cursor: pointer;
}

/* On a folder-tab (row click switches to the tab) the chevron is the collapse
   affordance, so make it an obvious, hoverable hit target. */
.tab-group-chevron:hover {
    background: var(--zj-surface-active);
    color: var(--zj-fg);
}

.tab-group-name {
    flex: 1 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-group-count {
    flex: none;
    font-size: 10px;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 99px;
    background: var(--zj-surface-hover);
    color: var(--zj-text-dim);
}

/* A folder row that is also a switchable tab (a terminal named "gst/upstream"
   that also parents "gst/upstream/cuda-rs"): normal-weight label, and its
   hover actions behave like a tab pill's. */
.tab-group-row.tab-group-tab .tab-group-name {
    font-weight: 400;
}

.tab-group-row .tab-item-close,
.tab-group-row .tab-item-rename {
    visibility: hidden;
}

.tab-group-row:hover .tab-item-close,
.tab-group-row:hover .tab-item-rename {
    visibility: visible;
}

.tab-item-num {
    flex: none;
    min-width: 14px;
    font-size: 10px;
    text-align: center;
    color: var(--zj-text-dim);
}

.tab-item-name {
    flex: 1 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-item-bell {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #e2b340;
}

.tab-item-count {
    flex: none;
    font-size: 10px;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 99px;
    background: var(--zj-surface-hover);
    color: var(--zj-text-dim);
}

.tab-item-close,
.tab-item-rename {
    flex: none;
    width: 16px;
    text-align: center;
    font-size: 14px;
    line-height: 1;
    border-radius: 4px;
    color: var(--zj-text-dim);
    visibility: hidden;
}

.tab-item-rename {
    font-size: 11px;
}

.tab-item:hover .tab-item-close,
.tab-item:hover .tab-item-rename {
    visibility: visible;
}

.tab-item-close:hover,
.tab-item-rename:hover {
    color: var(--zj-fg);
    background: var(--zj-surface-active);
}

.tab-item-rename-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 1px 4px;
    border: 1px solid color-mix(in srgb, var(--zj-fg) 25%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--zj-bg) 70%, transparent);
    color: var(--zj-fg);
    font-family: inherit;
    font-size: 13px;
    outline: none;
}

#tab-sidebar-new-tab {
    flex: none;
    /* leave room for the fixed bottom-left sidebar toggle */
    margin: 8px 8px 8px 46px;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--zj-text-dim);
    font-family: var(--zj-ui-font);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
}

#tab-sidebar-new-tab:hover {
    background: var(--zj-surface-hover);
    color: var(--zj-fg);
}

#tab-sidebar-toggle {
    position: fixed;
    bottom: 10px;
    left: 10px;
    z-index: 10;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    min-width: 28px;
    max-width: 190px;
    padding: 0 7px;
    border: 1px solid color-mix(in srgb, var(--zj-fg) 22%, transparent);
    border-radius: 7px;
    background: var(--zj-surface-hover);
    color: var(--zj-fg);
    font-family: var(--zj-ui-font);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.85;
    transition: opacity 140ms ease, background 140ms ease;
}

/* Idle fade: after a few seconds without tab activity the chip nearly
   vanishes (slow fade out, quick wake). */
#tab-sidebar-toggle.idle {
    opacity: 0.12;
    transition: opacity 600ms ease, background 140ms ease;
}

#tab-sidebar-toggle:hover,
#tab-sidebar-toggle.idle:hover {
    opacity: 1;
    background: var(--zj-surface-active);
}

/* Active-tab indicator on the chip, shown only while the bar is hidden */
#tab-sidebar-toggle-name {
    display: none;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

#tab-sidebar-toggle.show-name #tab-sidebar-toggle-name {
    display: inline-block;
}

/* Touch / no-hover: reserve room at the bottom of the sidebar for the
   full-width toggle bar so it never overlaps the last tab / new-tab button. */
body.no-hover #tab-sidebar {
    padding-bottom: 34px;
}

/* Touch / no-hover: the toggle is a full-width bar along the bottom of the
   sidebar — an always-visible tap target (no floating chip that can fade or
   be hard to hit). It keeps showing the active tab name like the chip does. */
body.no-hover #tab-sidebar-toggle {
    left: 0;
    bottom: 0;
    width: 232px;
    max-width: 232px;
    height: 34px;
    border: none;
    border-top: 1px solid color-mix(in srgb, var(--zj-fg) 18%, transparent);
    border-radius: 0;
    justify-content: flex-start;
    opacity: 1;
    background: var(--zj-surface-hover);
}

/* In overlay mode the sidebar floats over the terminal, so the toggle should
   span the whole viewport width along the bottom. */
body.no-hover.tab-bar-overlay #tab-sidebar-toggle {
    width: 100vw;
    max-width: 100vw;
}

/* always show the active tab name on the touch bar (not just when hidden) */
body.no-hover #tab-sidebar-toggle-name {
    display: inline-block;
}

/* Fuzzy tab search palette (search_tab_shortcut, Ctrl+K by default) */
#tab-palette {
    position: fixed;
    top: 16%;
    left: 50%;
    transform: translateX(-50%) scale(0.98);
    width: min(480px, 80vw);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--zj-fg) 15%, transparent);
    background: color-mix(in srgb, var(--zj-surface) 90%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    color: var(--zj-fg);
    font-family: var(--zj-ui-font);
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease, transform 120ms ease;
    z-index: 30;
}

#tab-palette.visible {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(-50%) scale(1);
}

#tab-palette-input {
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--zj-fg) 12%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--zj-bg) 70%, transparent);
    color: var(--zj-fg);
    font-family: inherit;
    font-size: 14px;
    outline: none;
}

#tab-palette-input:focus {
    border-color: color-mix(in srgb, var(--zj-fg) 30%, transparent);
}

#tab-palette-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 40vh;
    overflow-y: auto;
}

.tab-palette-item {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 14px;
    color: var(--zj-text-dim);
    cursor: pointer;
}

.tab-palette-item:hover {
    background: var(--zj-surface-hover);
}

.tab-palette-item.selected {
    background: var(--zj-surface-active);
    color: var(--zj-fg);
}

.tab-palette-num {
    flex: none;
    min-width: 16px;
    font-size: 11px;
    text-align: right;
    color: var(--zj-text-dim);
}

.tab-palette-name {
    flex: 1 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-palette-folder {
    flex: none;
    max-width: 140px;
    font-size: 11px;
    color: var(--zj-text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-palette-empty {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--zj-text-dim);
}

/* Overlay mode (runtime, toggled with the tab_bar_toggle_shortcut peek): the
   left sidebar floats over the terminal instead of taking layout space, so
   tab_bar_opacity lets content show through it. Pinned mode (chip click)
   keeps it in the layout. The top strip is always an overlay. */
body.tab-bar-overlay:not(.tab-bar-top) #tab-sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: 232px;
    flex: none;
    z-index: 5;
}

/* Top-strip mode (web_client.tab_bar_position "top"): the bar overlays the
   terminal instead of taking layout space, so tab_bar_opacity lets content
   show through it. */
body.tab-bar-top #tab-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 42px;
    flex: none;
    flex-direction: row;
    align-items: center;
    z-index: 5;
}

body.tab-bar-top #tab-sidebar-header {
    flex: none;
    max-width: 180px;
    min-height: 0;
    padding: 0 4px 0 12px;
}

body.tab-bar-top #tab-sidebar-list {
    flex: 1 1 auto;
    flex-direction: row;
    align-items: center;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0 6px;
    gap: 4px;
}

body.tab-bar-top .tab-item {
    flex: 0 0 auto;
    max-width: 200px;
    padding: 5px 10px;
}

body.tab-bar-top #tab-sidebar-new-tab {
    flex: none;
    margin: 0 10px 0 4px;
    padding: 5px 10px;
    white-space: nowrap;
}
    `;
    document.head.appendChild(style);
}
