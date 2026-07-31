use serde::{Deserialize, Serialize};
use zellij_utils::{input::config::Config, pane_size::Size};

#[derive(Serialize, Deserialize, Debug, Clone)]

pub struct WebClientToWebServerControlMessage {
    pub web_client_id: String,
    pub payload: WebClientToWebServerControlMessagePayload,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum WebClientToWebServerControlMessagePayload {
    TerminalResize(Size),
    TerminalResizeRendering(Size),
    TerminalSizeSettled(Size),
    TerminalMetrics(TerminalMetricsPayload),
    SoftKeyboardVisibilityChanged {
        visible: bool,
    },
    NestedSessionFrameFromHost {
        payload_bytes: Vec<u8>,
    },
    // A web-client frontend piping a message to its companion plugin. The frontend
    // carries the `web_plugin_id` that was injected when the companion was enabled;
    // the server validates it against the authenticated connection, so a frontend can
    // only ever reach its own companion — it cannot address, load, or broadcast to
    // any other plugin.
    PipeToPlugin {
        web_plugin_id: String,
        name: String,
        payload: Option<String>,
    },
    // Sent once the control channel is up: "which web companions do I have?".
    // The server re-announces them via WebPluginEnabled. Race-proofs enable-time
    // delivery and re-syncs after a reconnect.
    RequestWebPlugins,
    // The user's answer to a companion's permission prompt.
    WebPluginPermissionResponse {
        web_plugin_id: String,
        granted: bool,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TerminalMetricsPayload {
    pub cell_pixel_width: usize,
    pub cell_pixel_height: usize,
    pub text_area_pixel_width: usize,
    pub text_area_pixel_height: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum WebServerToWebClientControlMessage {
    SetConfig(SetConfigPayload),
    QueryTerminalSize,
    Log {
        lines: Vec<String>,
    },
    LogError {
        lines: Vec<String>,
    },
    SwitchedSession {
        new_session_name: String,
    },
    SetSoftKeyboard {
        on: bool,
    },
    // A web companion plugin was enabled for this client. The server minted an
    // unguessable `web_plugin_id` bound to (this connection, that plugin); the
    // frontend stores it and echoes it on every call to/from that companion.
    WebPluginEnabled {
        extension: String,
        web_plugin_id: String,
    },
    // A web companion plugin posted a message to its frontend. The `web_plugin_id`
    // tells the frontend which companion it came from (the server stamped it from
    // the authenticated binding, so a plugin can only ever reach its own frontend).
    WebPluginMessage {
        web_plugin_id: String,
        payload: String,
    },
    // A web companion's frontend is now served at /assets/webext/<web_plugin_id>.js.
    // The frontend carries no JS here — the browser imports it from that URL.
    WebPluginFrontend {
        web_plugin_id: String,
    },
    // A web companion is requesting permissions; the browser prompts the user and
    // answers with WebPluginPermissionResponse.
    WebPluginPermissionRequest {
        web_plugin_id: String,
        permissions: Vec<String>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SetConfigPayload {
    pub font: String,
    pub theme: SetConfigPayloadTheme,
    pub cursor_blink: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_inactive_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    pub mac_option_is_meta: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u16>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigPayloadTheme {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub black: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_black: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_blue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_cyan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_green: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_magenta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_red: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_white: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bright_yellow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_accent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cyan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub green: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magenta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub red: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_foreground: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_inactive_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub white: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yellow: Option<String>,
}

impl From<&Config> for SetConfigPayload {
    fn from(config: &Config) -> Self {
        let font = config.web_client.font.clone();

        let palette = config.theme_config(config.options.theme.as_ref());
        let web_client_theme_from_config = config.web_client.theme.as_ref();

        let mut theme = SetConfigPayloadTheme::default();

        theme.background = web_client_theme_from_config
            .and_then(|theme| theme.background.clone())
            .or_else(|| palette.map(|p| p.text_unselected.background.as_rgb_str()));
        theme.foreground = web_client_theme_from_config
            .and_then(|theme| theme.foreground.clone())
            .or_else(|| palette.map(|p| p.text_unselected.base.as_rgb_str()));
        theme.black = web_client_theme_from_config.and_then(|theme| theme.black.clone());
        theme.blue = web_client_theme_from_config.and_then(|theme| theme.blue.clone());
        theme.bright_black =
            web_client_theme_from_config.and_then(|theme| theme.bright_black.clone());
        theme.bright_blue =
            web_client_theme_from_config.and_then(|theme| theme.bright_blue.clone());
        theme.bright_cyan =
            web_client_theme_from_config.and_then(|theme| theme.bright_cyan.clone());
        theme.bright_green =
            web_client_theme_from_config.and_then(|theme| theme.bright_green.clone());
        theme.bright_magenta =
            web_client_theme_from_config.and_then(|theme| theme.bright_magenta.clone());
        theme.bright_red = web_client_theme_from_config.and_then(|theme| theme.bright_red.clone());
        theme.bright_white =
            web_client_theme_from_config.and_then(|theme| theme.bright_white.clone());
        theme.bright_yellow =
            web_client_theme_from_config.and_then(|theme| theme.bright_yellow.clone());
        theme.cursor = web_client_theme_from_config.and_then(|theme| theme.cursor.clone());
        theme.cursor_accent =
            web_client_theme_from_config.and_then(|theme| theme.cursor_accent.clone());
        theme.cyan = web_client_theme_from_config.and_then(|theme| theme.cyan.clone());
        theme.green = web_client_theme_from_config.and_then(|theme| theme.green.clone());
        theme.magenta = web_client_theme_from_config.and_then(|theme| theme.magenta.clone());
        theme.red = web_client_theme_from_config.and_then(|theme| theme.red.clone());
        theme.selection_background = web_client_theme_from_config
            .and_then(|theme| theme.selection_background.clone())
            .or_else(|| palette.map(|p| p.text_selected.background.as_rgb_str()));
        theme.selection_foreground = web_client_theme_from_config
            .and_then(|theme| theme.selection_foreground.clone())
            .or_else(|| palette.map(|p| p.text_selected.base.as_rgb_str()));
        theme.selection_inactive_background = web_client_theme_from_config
            .and_then(|theme| theme.selection_inactive_background.clone());
        theme.white = web_client_theme_from_config.and_then(|theme| theme.white.clone());
        theme.yellow = web_client_theme_from_config.and_then(|theme| theme.yellow.clone());

        let cursor_blink = config.web_client.cursor_blink;
        let mac_option_is_meta = config.web_client.mac_option_is_meta;
        let cursor_style = config
            .web_client
            .cursor_style
            .as_ref()
            .map(|s| s.to_string());
        let cursor_inactive_style = config
            .web_client
            .cursor_inactive_style
            .as_ref()
            .map(|s| s.to_string());

        let font_size = config.web_client.font_size;

        SetConfigPayload {
            font,
            theme,
            cursor_blink,
            mac_option_is_meta,
            cursor_style,
            cursor_inactive_style,
            font_size,
        }
    }
}
