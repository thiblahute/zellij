use std::collections::BTreeMap;
use zellij_tile::prelude::*;

use serde::Serialize;

// This extension's browser frontend, carried inside the wasm. On load we hand it
// to the host, which serves it at /assets/webext/<web_plugin_id>.js for the
// browser to import — the plugin is a single self-contained artifact.
const FRONTEND: &str = include_str!("frontend.js");

// The tab bar as a web extension.
//
// This is the same feature as zellij's terminal-rendered tab-bar, but built
// entirely on the web-extension infrastructure: it renders NOTHING to the
// terminal grid. Instead it is the companion WASM plugin behind an HTML tab bar
// (assets/tab-bar.js). It:
//
//   - subscribes to TabUpdate and forwards the tab list to its own web frontend
//     via web_post_message (stamped server-side with this plugin's web_plugin_id,
//     so it reaches only this client's tab bar);
//   - receives tab actions piped from that frontend (PipeSource::Web) and performs
//     them through its granted permissions.
//
// The whole point: no direct core Actions from the browser, and no bespoke
// tab-state protocol on the client<->server wire — the tab data rides the generic
// web_post_message channel, and every command flows through this permissioned
// plugin.
//
// Pipe protocol (payload in parens):
//   "web:go_to_tab"   (1-based tab index)     -> go_to_tab
//   "web:new_tab"     ()                       -> new_tab
//   "web:close_tab"   (stable tab_id)          -> close_tab_with_id
//   "web:rename_tab"  ("<tab_id>:<new name>")  -> rename_tab_with_id (stable id)

// Field names match what the ported tab-bar frontend (tabs.js) reads: the stable
// `tabId` (used for rename and close), the 0-based `position` (the frontend derives
// the 1-based go_to_tab index as position + 1), the `name`, and `active`.
#[derive(Serialize)]
struct TabJson {
    #[serde(rename = "tabId")]
    tab_id: u64,
    position: u32,
    name: String,
    active: bool,
}

#[derive(Default)]
struct State {
    tabs: Vec<TabInfo>,
}

register_plugin!(State);

impl ZellijPlugin for State {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        // Reading tab state and changing the active/existing tabs are exactly the
        // permissions a tab bar needs; as a trusted web companion these are granted
        // for us at enable time.
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ChangeApplicationState,
        ]);
        subscribe(&[EventType::TabUpdate, EventType::PermissionRequestResult]);
        set_web_frontend(FRONTEND);
    }

    fn update(&mut self, event: Event) -> bool {
        if let Event::TabUpdate(tabs) = event {
            self.tabs = tabs;
            self.post_tabs();
        }
        false
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        // Only act on messages from our web frontend (the provenance check).
        if !matches!(pipe_message.source, PipeSource::Web(_)) {
            return false;
        }
        let payload = pipe_message.payload.clone().unwrap_or_default();
        match pipe_message.name.as_str() {
            "web:go_to_tab" => {
                // switch_tab_to is 1-based (matches our index = position + 1).
                if let Ok(index) = payload.trim().parse::<u32>() {
                    switch_tab_to(index);
                }
            },
            "web:new_tab" => {
                new_tab(Option::<&str>::None, Option::<&str>::None);
            },
            "web:request_tabs" => {
                // The frontend asks for the current tab list when it (re)loads. The
                // first TabUpdate we posted at enable time can be lost if the
                // browser's control channel wasn't up yet (or on a reconnect), so
                // re-post whatever we last received. self.tabs was populated by the
                // TabUpdate we get on subscribe, independent of the browser.
                self.post_tabs();
            },
            "web:close_tab" => {
                // Close by stable tab_id, never by position: tab positions shift
                // under concurrent clients / new tabs / reorders, so a stale
                // focus-then-close could kill the wrong tab. close_tab_with_id is
                // atomic on the server (Action::CloseTabById).
                if let Ok(tab_id) = payload.trim().parse::<u64>() {
                    close_tab_with_id(tab_id);
                }
            },
            "web:rename_tab" => {
                // "<tab_id>:<new name>" — rename by stable id so it isn't racy.
                if let Some((id_str, new_name)) = payload.split_once(':') {
                    if let Ok(tab_id) = id_str.trim().parse::<u64>() {
                        rename_tab_with_id(tab_id, new_name);
                    }
                }
            },
            _ => {},
        }
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        // Web-frontend plugin: no terminal rendering.
    }
}

impl State {
    fn post_tabs(&self) {
        let tabs: Vec<TabJson> = self
            .tabs
            .iter()
            .map(|t| TabJson {
                tab_id: t.tab_id as u64,
                position: t.position as u32,
                name: t.name.clone(),
                active: t.active,
            })
            .collect();
        let msg = serde_json::json!({ "kind": "tabs", "tabs": tabs });
        web_post_message(&msg.to_string());
    }
}
