pub mod bridge;
pub mod config;
pub mod paths;
pub mod pty;
pub mod session;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use bridge::{BridgeState, PtyRegistry, TauriEventSink};
use config::ConfigStore;
use session::SessionStore;

const EVENT_CONFIG_CHANGED: &str = "config:changed";

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let registry = Arc::new(PtyRegistry::new());
            let sink = Arc::new(TauriEventSink::new(app.handle().clone()));
            app.manage(BridgeState::new(registry, sink));

            // Config store + hot-reload watcher. We use the infallible
            // constructor so a corrupt config.toml falls back to defaults
            // and the app still boots — the user can fix the file at
            // leisure (and the watcher will pick up the next valid save).
            let cfg_store = Arc::new(ConfigStore::open_or_default(paths::config_file()));
            let app_for_emit = app.handle().clone();
            if let Err(e) = cfg_store.spawn_watcher(move |cfg| {
                let _ = app_for_emit.emit(EVENT_CONFIG_CHANGED, cfg);
            }) {
                eprintln!("relay: failed to install config watcher: {e}");
            }
            app.manage(cfg_store);

            // Session store (named sessions + autosave).
            let session_store = Arc::new(SessionStore::new(
                paths::sessions_dir(),
                paths::autosave_file(),
            ));
            app.manage(session_store);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            bridge::pty_spawn,
            bridge::pty_write,
            bridge::pty_resize,
            bridge::pty_kill,
            bridge::pty_send_text,
            config::config_load,
            config::config_save,
            config::config_export,
            config::config_import,
            session::session_list,
            session::session_save,
            session::session_load,
            session::session_delete,
            session::session_autosave_write,
            session::session_autosave_read,
            session::session_scrollback_write,
            session::session_scrollback_read,
            session::session_autosave_scrollback_write,
            session::session_autosave_scrollback_read,
            session::session_autosave_scrollback_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke() {
        assert_eq!(
            greet("world"),
            "Hello, world! You've been greeted from Rust!"
        );
    }
}
