//! Session persistence: named save / load, autosave on exit, restore on
//! launch, and optional size-capped scrollback.
//!
//! The on-wire format is JSON (rather than TOML) because the layout tree is
//! a tagged-union and serde-json handles that natively; TOML stays the home
//! of the user-editable settings file.
//!
//! Disk layout (see `paths.rs`):
//!
//! ```text
//! ~/.config/relay/sessions/<name>.json
//! ~/.config/relay/sessions/<name>.scrollback/<paneId>.bin
//! ~/.config/relay/autosave.json
//! ```
//!
//! `SessionData` carries a `rules` slot that is currently always an empty
//! array; the pipe-rule type lands in a later PR but the slot is reserved
//! now so old session files keep round-tripping after that ships.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// On-disk session shape. All non-required fields use `#[serde(default)]` so
/// older files (no `rules`, no `scrollback`) continue to deserialize after we
/// extend the schema.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionData {
    /// Free-form layout snapshot — produced by the frontend, opaque to Rust.
    /// Persisting it as raw JSON lets us evolve the layout schema without
    /// touching the Rust side.
    pub layout: serde_json::Value,
    /// Settings overrides recorded with the session (font size, send opts).
    /// Optional — most sessions inherit the global config.
    pub send_options: Option<serde_json::Value>,
    /// Reserved for pipe rules — empty for now.
    pub rules: Vec<serde_json::Value>,
    /// Per-pane base64-or-binary scrollback dumps, opt-in. Keyed by pane id.
    /// Stored alongside (not inside) this file so a huge scrollback doesn't
    /// bloat the session JSON itself.
    pub scrollback_keys: Vec<String>,
    /// ISO-8601 timestamp of the last save. Set by `SessionStore::save`.
    pub saved_at: String,
    /// Free-form display name. Mirrors the filename for named sessions; empty
    /// for the autosave slot.
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub name: String,
    pub saved_at: String,
    pub pane_count: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("invalid session name: {0}")]
    InvalidName(String),
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Path-only handle. All operations re-derive paths from the configured
/// roots so a single store instance survives a config directory change.
pub struct SessionStore {
    sessions_dir: PathBuf,
    autosave_path: PathBuf,
}

impl SessionStore {
    pub fn new(sessions_dir: PathBuf, autosave_path: PathBuf) -> Self {
        Self {
            sessions_dir,
            autosave_path,
        }
    }

    pub fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }

    pub fn autosave_path(&self) -> &Path {
        &self.autosave_path
    }

    fn ensure_dir(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.sessions_dir)
    }

    fn validate_name(name: &str) -> Result<(), SessionError> {
        // Keep names safe to use as filenames on macOS: no path separators,
        // no leading dot (to avoid hiding the file), no empty strings.
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name.starts_with('.')
            || name == ".."
        {
            return Err(SessionError::InvalidName(name.into()));
        }
        Ok(())
    }

    fn session_file(&self, name: &str) -> PathBuf {
        self.sessions_dir.join(format!("{name}.json"))
    }

    fn scrollback_dir(&self, name: &str) -> PathBuf {
        self.sessions_dir.join(format!("{name}.scrollback"))
    }

    /// Directory holding per-pane scrollback dumps for the *autosave* slot.
    /// Lives next to `autosave.json` (mirroring the named-session layout)
    /// rather than under `sessions/` so the two sets stay logically
    /// distinct on disk.
    pub fn autosave_scrollback_dir(&self) -> PathBuf {
        self.autosave_path.with_extension("scrollback")
    }

    fn pane_count(layout: &serde_json::Value) -> usize {
        // Layout is opaque JSON to Rust, but for the metadata listing we
        // optimistically pull `panes.<id>` keys. Falls back to 0 if the
        // shape doesn't match.
        layout
            .get("panes")
            .and_then(|p| p.as_object())
            .map(|o| o.len())
            .unwrap_or(0)
    }

    /// List sessions sorted by filename (alphabetical). Best-effort: a
    /// corrupt file shows up as `pane_count = 0` rather than crashing the
    /// whole listing.
    pub fn list(&self) -> Result<Vec<SessionMetadata>, SessionError> {
        if !self.sessions_dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.sessions_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let parsed: SessionData = serde_json::from_str(&text).unwrap_or_default();
            out.push(SessionMetadata {
                name: stem.to_string(),
                saved_at: parsed.saved_at,
                pane_count: Self::pane_count(&parsed.layout),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub fn save(&self, name: &str, mut data: SessionData) -> Result<(), SessionError> {
        Self::validate_name(name)?;
        self.ensure_dir()?;
        data.name = name.to_string();
        if data.saved_at.is_empty() {
            data.saved_at = current_timestamp();
        }
        let text = serde_json::to_string_pretty(&data)?;
        let path = self.session_file(name);
        // Atomic rename so a concurrent reader never sees a torn file.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn load(&self, name: &str) -> Result<SessionData, SessionError> {
        Self::validate_name(name)?;
        let path = self.session_file(name);
        let text = std::fs::read_to_string(&path).map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => SessionError::NotFound(name.into()),
            _ => SessionError::Io(err),
        })?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn delete(&self, name: &str) -> Result<(), SessionError> {
        Self::validate_name(name)?;
        let path = self.session_file(name);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(SessionError::NotFound(name.into()))
            }
            Err(err) => return Err(SessionError::Io(err)),
        }
        // Best-effort scrollback cleanup. Ignore errors here — leftover
        // scrollback files don't break correctness.
        let _ = std::fs::remove_dir_all(self.scrollback_dir(name));
        Ok(())
    }

    pub fn write_autosave(&self, mut data: SessionData) -> Result<(), SessionError> {
        if let Some(parent) = self.autosave_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if data.saved_at.is_empty() {
            data.saved_at = current_timestamp();
        }
        let text = serde_json::to_string_pretty(&data)?;
        let tmp = self.autosave_path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &self.autosave_path)?;
        Ok(())
    }

    pub fn read_autosave(&self) -> Result<Option<SessionData>, SessionError> {
        match std::fs::read_to_string(&self.autosave_path) {
            Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(SessionError::Io(err)),
        }
    }

    /// Write a single pane's scrollback. Truncates to `max_bytes` from the
    /// *tail* (newest data wins, so the user sees the most recent output
    /// rather than ancient banner text).
    pub fn write_scrollback(
        &self,
        name: &str,
        pane_id: &str,
        bytes: &[u8],
        max_bytes: u64,
    ) -> Result<(), SessionError> {
        Self::validate_name(name)?;
        let dir = self.scrollback_dir(name);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{pane_id}.bin"));
        let cap = max_bytes as usize;
        let slice = if bytes.len() > cap {
            &bytes[bytes.len() - cap..]
        } else {
            bytes
        };
        std::fs::write(&path, slice)?;
        Ok(())
    }

    pub fn read_scrollback(&self, name: &str, pane_id: &str) -> Result<Vec<u8>, SessionError> {
        Self::validate_name(name)?;
        let path = self.scrollback_dir(name).join(format!("{pane_id}.bin"));
        match std::fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(SessionError::Io(err)),
        }
    }

    /// Autosave variant of `write_scrollback`. No `validate_name` — the
    /// "name" is implicit (the autosave slot), so the frontend supplies
    /// only the pane id.
    pub fn write_autosave_scrollback(
        &self,
        pane_id: &str,
        bytes: &[u8],
        max_bytes: u64,
    ) -> Result<(), SessionError> {
        let dir = self.autosave_scrollback_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{pane_id}.bin"));
        let cap = max_bytes as usize;
        let slice = if bytes.len() > cap {
            &bytes[bytes.len() - cap..]
        } else {
            bytes
        };
        std::fs::write(&path, slice)?;
        Ok(())
    }

    pub fn read_autosave_scrollback(&self, pane_id: &str) -> Result<Vec<u8>, SessionError> {
        let path = self
            .autosave_scrollback_dir()
            .join(format!("{pane_id}.bin"));
        match std::fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(SessionError::Io(err)),
        }
    }

    /// Wipe the autosave scrollback dir. Used when the user disables
    /// scrollback persistence so the next autosave run doesn't leak old
    /// dumps that no longer correspond to live panes.
    pub fn clear_autosave_scrollback(&self) -> Result<(), SessionError> {
        let dir = self.autosave_scrollback_dir();
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(SessionError::Io(err)),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Minimal RFC3339 timestamp without pulling in `chrono`. Falls back to
/// epoch-seconds-as-string if `SystemTime` can't be read.
fn current_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => format!("{}", d.as_secs()),
        Err(_) => "0".into(),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn session_list(state: State<'_, Arc<SessionStore>>) -> Result<Vec<SessionMetadata>, String> {
    state.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_save(
    state: State<'_, Arc<SessionStore>>,
    name: String,
    data: SessionData,
) -> Result<(), String> {
    state.save(&name, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_load(
    state: State<'_, Arc<SessionStore>>,
    name: String,
) -> Result<SessionData, String> {
    state.load(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_delete(state: State<'_, Arc<SessionStore>>, name: String) -> Result<(), String> {
    state.delete(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_autosave_write(
    state: State<'_, Arc<SessionStore>>,
    data: SessionData,
) -> Result<(), String> {
    state.write_autosave(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_autosave_read(
    state: State<'_, Arc<SessionStore>>,
) -> Result<Option<SessionData>, String> {
    state.read_autosave().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_scrollback_write(
    state: State<'_, Arc<SessionStore>>,
    name: String,
    pane_id: String,
    bytes: Vec<u8>,
    max_bytes: u64,
) -> Result<(), String> {
    state
        .write_scrollback(&name, &pane_id, &bytes, max_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_scrollback_read(
    state: State<'_, Arc<SessionStore>>,
    name: String,
    pane_id: String,
) -> Result<Vec<u8>, String> {
    state
        .read_scrollback(&name, &pane_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_autosave_scrollback_write(
    state: State<'_, Arc<SessionStore>>,
    pane_id: String,
    bytes: Vec<u8>,
    max_bytes: u64,
) -> Result<(), String> {
    state
        .write_autosave_scrollback(&pane_id, &bytes, max_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_autosave_scrollback_read(
    state: State<'_, Arc<SessionStore>>,
    pane_id: String,
) -> Result<Vec<u8>, String> {
    state
        .read_autosave_scrollback(&pane_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_autosave_scrollback_clear(
    state: State<'_, Arc<SessionStore>>,
) -> Result<(), String> {
    state.clear_autosave_scrollback().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh_store() -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let autosave = dir.path().join("autosave.json");
        (dir, SessionStore::new(sessions, autosave))
    }

    fn sample_session() -> SessionData {
        SessionData {
            layout: json!({
                "tree": { "kind": "leaf", "paneId": "a" },
                "panes": { "a": { "id": "a", "label": "Pane 1" } },
                "focusedPaneId": "a"
            }),
            send_options: Some(json!({ "bracketedPaste": true, "trailingNewline": false })),
            rules: Vec::new(),
            scrollback_keys: Vec::new(),
            saved_at: String::new(),
            name: String::new(),
        }
    }

    #[test]
    fn save_list_load_round_trip() {
        let (_dir, store) = fresh_store();
        store.save("morning", sample_session()).expect("save");
        let listed = store.list().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "morning");
        assert_eq!(listed[0].pane_count, 1);

        let loaded = store.load("morning").expect("load");
        assert_eq!(loaded.name, "morning");
        assert!(!loaded.saved_at.is_empty());
        assert_eq!(loaded.layout, sample_session().layout);
    }

    #[test]
    fn delete_removes_session_and_scrollback() {
        let (_dir, store) = fresh_store();
        store.save("evening", sample_session()).expect("save");
        store
            .write_scrollback("evening", "a", b"hello", 1024)
            .expect("scroll");
        assert!(store.scrollback_dir("evening").exists());
        store.delete("evening").expect("delete");
        assert!(matches!(
            store.load("evening"),
            Err(SessionError::NotFound(_))
        ));
        assert!(!store.scrollback_dir("evening").exists());
    }

    #[test]
    fn autosave_round_trip() {
        let (_dir, store) = fresh_store();
        assert!(store.read_autosave().expect("read").is_none());
        store.write_autosave(sample_session()).expect("write");
        let back = store.read_autosave().expect("read").expect("some");
        assert_eq!(back.layout, sample_session().layout);
    }

    #[test]
    fn scrollback_truncates_to_cap_keeping_tail() {
        let (_dir, store) = fresh_store();
        store.save("perf", sample_session()).expect("save");
        let mut bytes = Vec::new();
        for i in 0..1000u32 {
            bytes.extend_from_slice(format!("line {i}\n").as_bytes());
        }
        let cap = 200u64;
        store
            .write_scrollback("perf", "a", &bytes, cap)
            .expect("write");
        let back = store.read_scrollback("perf", "a").expect("read");
        assert_eq!(back.len(), cap as usize);
        // Tail must contain the highest line number.
        let tail = String::from_utf8_lossy(&back);
        assert!(tail.contains("line 999"), "got tail: {tail:?}");
    }

    #[test]
    fn missing_rules_field_round_trips_for_forward_compat() {
        // A session written before the `rules` slot existed. `serde(default)`
        // on the field must make this still deserialize cleanly.
        let raw = r#"{
            "layout": { "tree": { "kind": "leaf", "paneId": "a" }, "panes": {} },
            "savedAt": "1700000000",
            "name": "legacy"
        }"#;
        let parsed: SessionData = serde_json::from_str(raw).expect("deserialize legacy");
        assert_eq!(parsed.name, "legacy");
        assert!(parsed.rules.is_empty());
        assert!(parsed.scrollback_keys.is_empty());
    }

    #[test]
    fn invalid_names_rejected() {
        let (_dir, store) = fresh_store();
        for bad in ["", "..", ".hidden", "with/slash", "back\\slash"] {
            assert!(
                matches!(
                    store.save(bad, sample_session()),
                    Err(SessionError::InvalidName(_))
                ),
                "expected rejection for {bad:?}"
            );
        }
    }

    #[test]
    fn autosave_scrollback_round_trip_with_cap() {
        let (_dir, store) = fresh_store();
        let mut bytes = Vec::new();
        for i in 0..500u32 {
            bytes.extend_from_slice(format!("row {i}\n").as_bytes());
        }
        let cap = 120u64;
        store
            .write_autosave_scrollback("pane-1", &bytes, cap)
            .expect("write");
        let back = store.read_autosave_scrollback("pane-1").expect("read");
        assert_eq!(back.len(), cap as usize);
        // The tail (newest output) survives the truncation.
        assert!(String::from_utf8_lossy(&back).contains("row 499"));
    }

    #[test]
    fn read_autosave_scrollback_missing_returns_empty() {
        let (_dir, store) = fresh_store();
        let back = store
            .read_autosave_scrollback("never-written")
            .expect("read");
        assert!(back.is_empty());
    }

    #[test]
    fn clear_autosave_scrollback_removes_dir() {
        let (_dir, store) = fresh_store();
        store
            .write_autosave_scrollback("pane-1", b"hi", 1024)
            .expect("write");
        assert!(store.autosave_scrollback_dir().exists());
        store.clear_autosave_scrollback().expect("clear");
        assert!(!store.autosave_scrollback_dir().exists());
        // Clearing twice is a no-op.
        store.clear_autosave_scrollback().expect("clear-again");
    }

    #[test]
    fn list_empty_when_dir_absent() {
        let (_dir, store) = fresh_store();
        // Sessions dir not yet created.
        assert!(store.list().expect("list").is_empty());
    }
}
