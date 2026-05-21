pub mod bridge;
pub mod config;
pub mod log;
pub mod paths;
pub mod pipe;
pub mod pty;
pub mod session;
pub mod ssh;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use bridge::{BridgeState, PaneOutputSink, PtyRegistry, SshState, TauriEventSink};
use config::ConfigStore;
use log::{CompiledLogConfig, LogRegistry};
use pipe::{PipeRegistry, TauriPipeEventSink};
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

            // Config store + hot-reload watcher. We use the infallible
            // constructor so a corrupt config.toml falls back to defaults
            // and the app still boots — the user can fix the file at
            // leisure (and the watcher will pick up the next valid save).
            let cfg_store = Arc::new(ConfigStore::open_or_default(paths::config_file()));

            // Logging registry: compile the current LoggingConfig once and
            // hand the registry to the bridge as a `PaneOutputSink` so
            // every PTY chunk lands in a file (when enabled).
            let logging_now = cfg_store.snapshot().logging.clone();
            let compiled = CompiledLogConfig::compile(&logging_now, paths::logs_dir())
                .unwrap_or_else(|_| CompiledLogConfig::disabled(paths::logs_dir()));
            let log_registry = Arc::new(LogRegistry::new(compiled));

            // Pipe-rule registry: holds rules, dispatches to other panes'
            // PTYs. Events go through a Tauri-aware sink.
            let pipe_sink = Arc::new(TauriPipeEventSink::new(app.handle().clone()));
            let pipe_registry = Arc::new(PipeRegistry::new(registry.clone(), pipe_sink));
            // Global ticker for `tailPeriodic` rules. We don't hold the
            // JoinHandle — the task lives for the app lifetime.
            pipe::spawn_ticker(pipe_registry.clone());

            // Both sinks observe every PTY chunk in addition to the
            // frontend event sink.
            let observers: Vec<Arc<dyn PaneOutputSink>> =
                vec![log_registry.clone(), pipe_registry.clone()];
            app.manage(BridgeState::with_observers(registry, sink, observers));

            // Wire the config watcher: re-compile + swap the LogRegistry's
            // config whenever the user edits config.toml, and forward the
            // raw event to the frontend so it can react to font / theme /
            // session / etc. changes too.
            let app_for_emit = app.handle().clone();
            let log_for_watcher = log_registry.clone();
            if let Err(e) = cfg_store.spawn_watcher(move |cfg| {
                if let Ok(next) = CompiledLogConfig::compile(&cfg.logging, paths::logs_dir()) {
                    log_for_watcher.swap_config(next);
                }
                let _ = app_for_emit.emit(EVENT_CONFIG_CHANGED, cfg);
            }) {
                eprintln!("relay: failed to install config watcher: {e}");
            }
            app.manage(cfg_store);
            app.manage(log_registry);
            app.manage(pipe_registry);

            // Session store (named sessions + autosave).
            let session_store = Arc::new(SessionStore::new(
                paths::sessions_dir(),
                paths::autosave_file(),
            ));
            app.manage(session_store);

            // SSH reconnect coordinator state (per-pane Notify slots).
            app.manage(Arc::new(SshState::new()));

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
            log::log_tail,
            pipe::pipe_list,
            pipe::pipe_upsert,
            pipe::pipe_delete,
            pipe::pipe_toggle,
            pipe::pipe_replace_all,
            bridge::ssh_reconnect,
            bridge::ssh_config_hosts,
            bridge::ssh_keychain_set,
            bridge::ssh_keychain_has,
            bridge::ssh_keychain_delete,
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
