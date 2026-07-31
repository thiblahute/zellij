use std::collections::BTreeMap;
use zellij_tile::prelude::*;

// The touch extra-keys row, as a web extension.
//
// The browser frontend (a Termux-style key row) renders keys that a phone's
// virtual keyboard lacks (Esc, Tab, arrows, Ctrl/Alt chords), tracks the sticky
// modifiers itself, and pipes the resulting terminal bytes to THIS companion,
// which writes them to the focused terminal. It exercises a different permission
// than the tab bar (WriteToStdin), demonstrating that the model generalises: two
// features, two distinct permission sets, the same channel.
//
// Pipe protocol:
//   "extrakeys:input"  payload = the raw bytes for the key/chord  -> write to stdin
const FRONTEND: &str = include_str!("frontend.js");

#[derive(Default)]
struct State;

register_plugin!(State);

impl ZellijPlugin for State {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        // Writing to the focused terminal is all this extension does, and it can do
        // nothing else. The user grants this in the browser permission prompt.
        request_permission(&[PermissionType::WriteToStdin]);
        subscribe(&[EventType::PermissionRequestResult]);
        set_web_frontend(FRONTEND);
    }

    fn update(&mut self, _event: Event) -> bool {
        false
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        // Only act on our own web frontend's messages (the provenance check).
        if !matches!(pipe_message.source, PipeSource::Web(_)) {
            return false;
        }
        if pipe_message.name == "extrakeys:input" {
            if let Some(bytes) = pipe_message.payload {
                // Permission-gated: this only reaches the terminal because the plugin
                // holds WriteToStdin. The web frontend never touches that authority.
                write_chars(&bytes);
                // Ack the round-trip so the frontend can confirm the key landed.
                web_post_message(&format!("{{\"kind\":\"wrote\",\"bytes\":{}}}", bytes.len()));
            }
        }
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        // Web-frontend plugin: no terminal rendering.
    }
}
