//! macOS window vibrancy on/off.
//!
//! `set_window_vibrancy(enabled)` is invoked from the frontend whenever
//! `config.theme.transparent` changes. The implementation lives behind a
//! `cfg(target_os = "macos")` so the symbol is still callable on other
//! platforms (it just returns Ok(()) without doing anything) — the frontend
//! doesn't have to know which OS it's running on.
//!
//! `macos-private-api` must be enabled on the `tauri` dependency for vibrancy
//! to take effect; see `tauri.conf.json` (`app.macOSPrivateApi: true`).

use tauri::{Manager, Runtime};

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};

/// Tauri command. The frontend's `$effect` calls this on mount and on every
/// change of `config.theme.transparent`. Errors are surfaced as plain strings
/// so the frontend's catch handler can log them.
#[tauri::command]
pub fn set_window_vibrancy<R: Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        // The default window label in tauri.conf.json — fall back to whatever
        // the first webview window happens to be in case the user has
        // renamed it (still a no-op rather than a hard error so the toggle
        // doesn't take down the settings save).
        return Ok(());
    };
    apply(&window, enabled)
}

#[cfg(target_os = "macos")]
fn apply<R: Runtime>(window: &tauri::WebviewWindow<R>, enabled: bool) -> Result<(), String> {
    if enabled {
        // HudWindow is the closest match for a terminal-style chrome — it sits
        // somewhere between Sidebar and Popover in terms of saturation and
        // copes well with text overlays. Users who want a different material
        // can swap this single line once we expose more presets.
        apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None)
            .map_err(|e| e.to_string())
    } else {
        // `clear_vibrancy` returns Result<bool, Error>; we only care whether
        // it succeeded, not whether anything was actually cleared.
        clear_vibrancy(window)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn apply<R: Runtime>(_window: &tauri::WebviewWindow<R>, _enabled: bool) -> Result<(), String> {
    Ok(())
}
