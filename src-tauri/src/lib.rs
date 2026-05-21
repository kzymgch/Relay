pub mod bridge;
pub mod pty;

use std::sync::Arc;

use tauri::Manager;

use bridge::{BridgeState, PtyRegistry, TauriEventSink};

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            bridge::pty_spawn,
            bridge::pty_write,
            bridge::pty_resize,
            bridge::pty_kill,
            bridge::pty_send_text,
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
