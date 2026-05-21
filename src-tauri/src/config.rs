//! User configuration: `~/.config/relay/config.toml` loader with defaults,
//! schema validation, and a `notify`-backed hot-reload watcher.
//!
//! The on-disk format is TOML (per spec §15). Every field is `#[serde(default)]`
//! so a partial file inherits the rest of the defaults — users can start with
//! an empty file and bring up keys one at a time.
//!
//! The store is the single source of truth for the in-process copy: callers
//! read with [`ConfigStore::snapshot`], write with [`ConfigStore::save`], and
//! react to external edits via the watcher callback registered in
//! [`ConfigStore::spawn_watcher`].

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RelayConfig {
    pub font: FontConfig,
    pub theme: ThemeConfig,
    pub send: SendConfig,
    pub scrollback: ScrollbackConfig,
    pub session: SessionSettings,
    pub logging: LoggingConfig,
    /// `action.id -> "cmd+p"`. Stored verbatim; the actual binding system
    /// lives on the frontend (and full customisation lands in a later PR).
    pub keybind: BTreeMap<String, String>,
    pub default_pane: PaneSpecConfig,
    pub pane: PaneSection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct FontConfig {
    pub family: String,
    pub size: u16,
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            family: "Menlo".into(),
            size: 13,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeConfig {
    /// `"dark"` or `"light"`. Stored verbatim; rendering wiring lands later.
    pub mode: String,
    pub preset: String,
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            mode: "dark".into(),
            preset: "default".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SendConfig {
    pub bracketed_paste: bool,
    pub trailing_newline: bool,
}

impl Default for SendConfig {
    fn default() -> Self {
        Self {
            bracketed_paste: true,
            trailing_newline: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ScrollbackConfig {
    pub lines: u32,
    pub persist_on_exit: bool,
    /// Per-pane cap when `persist_on_exit` is on. Defaults to 1 MiB.
    pub persist_max_bytes: u64,
}

impl Default for ScrollbackConfig {
    fn default() -> Self {
        Self {
            lines: 10_000,
            persist_on_exit: false,
            persist_max_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionSettings {
    pub autosave_on_exit: bool,
    pub restore_on_launch: bool,
}

impl Default for SessionSettings {
    fn default() -> Self {
        Self {
            autosave_on_exit: true,
            restore_on_launch: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PaneSpecConfig {
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
}

impl Default for PaneSpecConfig {
    fn default() -> Self {
        Self {
            label: "Pane".into(),
            command: "/bin/zsh".into(),
            args: vec!["-l".into()],
            cwd: None,
            env: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PaneSection {
    pub preset: Vec<PaneSpecConfig>,
}

/// Per-pane file logging. Empty `dir` is interpreted at load time as
/// `paths::logs_dir()` so the config can ship without absolute paths
/// baked in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct LoggingConfig {
    pub enabled: bool,
    pub dir: String,
    /// `"raw"` (write bytes verbatim, ANSI included) or `"plain"`
    /// (strip ANSI, mask secret regexes line-by-line).
    pub mode: String,
    /// Rotate when the current file passes this size. `0` disables size
    /// rotation; date rotation alone still applies if `daily_rotation`.
    pub max_bytes: u64,
    /// How many rotated files to keep per pane. Oldest are pruned first.
    pub max_files: u32,
    /// Roll to a fresh file when the local date changes, even if the
    /// size cap hasn't been hit yet.
    pub daily_rotation: bool,
    /// Regex sources applied to plain-mode lines. Each match is replaced
    /// with `***`. Invalid regexes are rejected by `validate`.
    pub secrets: Vec<String>,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            dir: String::new(),
            mode: "plain".into(),
            max_bytes: 10 * 1024 * 1024,
            max_files: 5,
            daily_rotation: true,
            secrets: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml parse: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("toml serialize: {0}")]
    Serialize(#[from] toml::ser::Error),
    #[error("validation: {0}")]
    Validation(String),
    #[error("watch: {0}")]
    Watch(#[from] notify::Error),
}

// ---------------------------------------------------------------------------
// Load / save / validate
// ---------------------------------------------------------------------------

/// Read a TOML config from `path`, falling back to defaults when the file
/// doesn't exist. Other errors (corrupt TOML, validation failure) propagate
/// so callers can show the user what went wrong.
pub fn load_or_default(path: &Path) -> Result<RelayConfig, ConfigError> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let cfg: RelayConfig = toml::from_str(&text)?;
            validate(&cfg)?;
            Ok(cfg)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(RelayConfig::default()),
        Err(err) => Err(ConfigError::Io(err)),
    }
}

/// Write the config to `path` atomically: serialize, then write to a sibling
/// `*.tmp`, then `rename`. Ensures the file watcher never observes a torn
/// half-written file.
pub fn save(path: &Path, cfg: &RelayConfig) -> Result<(), ConfigError> {
    validate(cfg)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = toml::to_string_pretty(cfg)?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn validate(cfg: &RelayConfig) -> Result<(), ConfigError> {
    if !(8..=32).contains(&cfg.font.size) {
        return Err(ConfigError::Validation(format!(
            "font.size must be in 8..=32, got {}",
            cfg.font.size
        )));
    }
    if cfg.scrollback.lines < 100 {
        return Err(ConfigError::Validation(format!(
            "scrollback.lines must be >= 100, got {}",
            cfg.scrollback.lines
        )));
    }
    match cfg.theme.mode.as_str() {
        "dark" | "light" => {}
        other => {
            return Err(ConfigError::Validation(format!(
                "theme.mode must be \"dark\" or \"light\", got {other:?}"
            )))
        }
    }
    for (idx, p) in cfg.pane.preset.iter().enumerate() {
        if p.command.trim().is_empty() {
            return Err(ConfigError::Validation(format!(
                "pane.preset[{idx}].command must not be empty"
            )));
        }
    }
    if cfg.default_pane.command.trim().is_empty() {
        return Err(ConfigError::Validation(
            "defaultPane.command must not be empty".into(),
        ));
    }
    match cfg.logging.mode.as_str() {
        "raw" | "plain" => {}
        other => {
            return Err(ConfigError::Validation(format!(
                "logging.mode must be \"raw\" or \"plain\", got {other:?}"
            )))
        }
    }
    for (idx, src) in cfg.logging.secrets.iter().enumerate() {
        if let Err(e) = regex::Regex::new(src) {
            return Err(ConfigError::Validation(format!(
                "logging.secrets[{idx}] is not a valid regex: {e}"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Store + watcher
// ---------------------------------------------------------------------------

/// In-process source of truth for the loaded config. Wraps the file path,
/// the latest validated copy, and a held `RecommendedWatcher` so the notify
/// background thread stays alive for the duration of the app.
pub struct ConfigStore {
    path: PathBuf,
    // `Arc` so the watcher's dispatch thread can hold its own clone and
    // update the cell when the file changes externally — without that the
    // in-memory `snapshot()` would drift away from disk.
    current: Arc<RwLock<RelayConfig>>,
    // Held purely to keep notify alive — dropping the watcher tears down the
    // watch thread.
    _watcher: Mutex<Option<RecommendedWatcher>>,
}

impl ConfigStore {
    pub fn open(path: PathBuf) -> Result<Self, ConfigError> {
        let cfg = load_or_default(&path)?;
        Ok(Self {
            path,
            current: Arc::new(RwLock::new(cfg)),
            _watcher: Mutex::new(None),
        })
    }

    /// Infallible variant — corrupt or unreadable files yield defaults so
    /// the app still boots. The caller can show an error toast separately.
    pub fn open_or_default(path: PathBuf) -> Self {
        let cfg = load_or_default(&path).unwrap_or_default();
        Self {
            path,
            current: Arc::new(RwLock::new(cfg)),
            _watcher: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Cheap clone of the current in-memory config.
    pub fn snapshot(&self) -> RelayConfig {
        self.current.read().expect("ConfigStore poisoned").clone()
    }

    /// Replace the in-memory copy and persist to disk.
    pub fn save(&self, cfg: RelayConfig) -> Result<(), ConfigError> {
        save(&self.path, &cfg)?;
        *self.current.write().expect("ConfigStore poisoned") = cfg;
        Ok(())
    }

    /// Re-read from disk; on success replace the in-memory copy. Returns the
    /// fresh config so callers can fan it out to listeners.
    pub fn reload(&self) -> Result<RelayConfig, ConfigError> {
        let cfg = load_or_default(&self.path)?;
        *self.current.write().expect("ConfigStore poisoned") = cfg.clone();
        Ok(cfg)
    }

    /// Write `cfg` to an arbitrary path (Settings → Export).
    pub fn export_to(&self, path: &Path) -> Result<(), ConfigError> {
        let cfg = self.snapshot();
        save(path, &cfg)
    }

    /// Read from an arbitrary path and adopt it as the new config (Settings →
    /// Import). Persists to the canonical path too so the next launch sees
    /// the same state.
    pub fn import_from(&self, path: &Path) -> Result<RelayConfig, ConfigError> {
        let cfg = load_or_default(path)?;
        self.save(cfg.clone())?;
        Ok(cfg)
    }

    /// Install a filesystem watcher on the config file. `on_change` runs on
    /// notify's internal thread after a 200 ms debounce; the new config has
    /// already been written into `self.current` before it fires, so the
    /// callback can just pass the snapshot along (e.g. to `app.emit`).
    ///
    /// Idempotent: a second call replaces the previous watcher.
    pub fn spawn_watcher<F>(&self, on_change: F) -> Result<(), ConfigError>
    where
        F: Fn(RelayConfig) + Send + Sync + 'static,
    {
        // notify can't watch a non-existent file, but it can watch the
        // parent directory and we filter by path in the callback. That also
        // covers atomic-rename saves (vim, most editors) where the file gets
        // unlinked and recreated.
        let dir = self
            .path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        std::fs::create_dir_all(&dir)?;

        let (tx, rx) = std::sync::mpsc::channel::<()>();
        // macOS FSEvents reports canonical paths (e.g. `/private/var/...`
        // for symlinks under `/var/...`), so we compare via filename rather
        // than the absolute path — the directory filter is already narrow
        // enough that aliasing is not a concern in practice.
        let target_name = self
            .path
            .file_name()
            .map(|s| s.to_os_string())
            .unwrap_or_default();
        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                if !matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) {
                    return;
                }
                if !event
                    .paths
                    .iter()
                    .any(|p| p.file_name() == Some(target_name.as_os_str()))
                {
                    return;
                }
                let _ = tx.send(());
            })?;
        watcher.watch(&dir, RecursiveMode::NonRecursive)?;

        // Debounce + dispatch loop. The thread holds its own Arc-clone of
        // the current-config cell so the in-memory snapshot stays in sync
        // with disk; otherwise `snapshot()` would lag behind external edits
        // until the next explicit `reload()`.
        let path = self.path.clone();
        let cell = self.current.clone();
        std::thread::spawn(move || loop {
            // Block until at least one event arrives.
            if rx.recv().is_err() {
                return;
            }
            // Drain anything that piles up during the debounce window.
            std::thread::sleep(Duration::from_millis(200));
            while rx.try_recv().is_ok() {}

            match load_or_default(&path) {
                Ok(cfg) => {
                    *cell.write().expect("ConfigStore poisoned") = cfg.clone();
                    on_change(cfg);
                }
                Err(_) => {
                    // Swallow — a transient parse error during the editor's
                    // mid-save state shouldn't crash the watcher. The next
                    // valid save will fire `on_change` again.
                }
            }
        });

        *self._watcher.lock().expect("ConfigStore poisoned") = Some(watcher);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn config_load(state: State<'_, Arc<ConfigStore>>) -> RelayConfig {
    state.snapshot()
}

#[tauri::command]
pub fn config_save(state: State<'_, Arc<ConfigStore>>, config: RelayConfig) -> Result<(), String> {
    state.save(config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_export(state: State<'_, Arc<ConfigStore>>, path: String) -> Result<(), String> {
    state.export_to(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_import(
    state: State<'_, Arc<ConfigStore>>,
    path: String,
) -> Result<RelayConfig, String> {
    state
        .import_from(Path::new(&path))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Instant;

    #[test]
    fn defaults_round_trip() {
        let cfg = RelayConfig::default();
        let text = toml::to_string_pretty(&cfg).expect("serialize");
        let back: RelayConfig = toml::from_str(&text).expect("deserialize");
        assert_eq!(back, cfg);
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let cfg = load_or_default(&path).expect("load");
        assert_eq!(cfg, RelayConfig::default());
    }

    #[test]
    fn partial_file_inherits_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[font]\nsize = 16\n").unwrap();
        let cfg = load_or_default(&path).expect("load");
        assert_eq!(cfg.font.size, 16);
        assert_eq!(cfg.font.family, FontConfig::default().family);
        assert_eq!(cfg.send, SendConfig::default());
    }

    #[test]
    fn invalid_font_size_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[font]\nsize = 99\n").unwrap();
        let err = load_or_default(&path).unwrap_err();
        assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn empty_pane_command_rejected() {
        let mut cfg = RelayConfig::default();
        cfg.pane.preset.push(PaneSpecConfig {
            command: "   ".into(),
            ..Default::default()
        });
        assert!(matches!(validate(&cfg), Err(ConfigError::Validation(_))));
    }

    #[test]
    fn save_then_reload_round_trips_custom_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut cfg = RelayConfig::default();
        cfg.font.family = "Iosevka".into();
        cfg.font.size = 15;
        cfg.send.trailing_newline = true;
        cfg.keybind.insert("palette.open".into(), "cmd+p".into());
        cfg.pane.preset.push(PaneSpecConfig {
            label: "lint".into(),
            command: "pnpm".into(),
            args: vec!["lint".into()],
            ..Default::default()
        });

        save(&path, &cfg).expect("save");
        let back = load_or_default(&path).expect("reload");
        assert_eq!(back, cfg);
    }

    #[test]
    fn store_save_updates_in_memory_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let store = ConfigStore::open(path).expect("open");
        let mut cfg = store.snapshot();
        cfg.font.size = 20;
        store.save(cfg.clone()).expect("save");
        assert_eq!(store.snapshot(), cfg);
    }

    #[test]
    fn logging_config_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut cfg = RelayConfig::default();
        cfg.logging.enabled = true;
        cfg.logging.dir = "/tmp/relay-logs".into();
        cfg.logging.mode = "raw".into();
        cfg.logging.max_bytes = 1024;
        cfg.logging.max_files = 3;
        cfg.logging.daily_rotation = false;
        cfg.logging.secrets = vec!["sk-[A-Za-z0-9]+".into()];
        save(&path, &cfg).expect("save");
        let back = load_or_default(&path).expect("load");
        assert_eq!(back, cfg);
    }

    #[test]
    fn invalid_logging_mode_rejected() {
        let mut cfg = RelayConfig::default();
        cfg.logging.mode = "weird".into();
        assert!(matches!(validate(&cfg), Err(ConfigError::Validation(_))));
    }

    #[test]
    fn invalid_secret_regex_rejected() {
        let mut cfg = RelayConfig::default();
        cfg.logging.secrets = vec!["(unterminated".into()];
        assert!(matches!(validate(&cfg), Err(ConfigError::Validation(_))));
    }

    #[test]
    fn watcher_fires_on_external_edit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // Seed an initial file so notify has something to watch from t=0.
        save(&path, &RelayConfig::default()).expect("seed");

        let store = ConfigStore::open(path.clone()).expect("open");
        let received: Arc<StdMutex<Vec<RelayConfig>>> = Arc::new(StdMutex::new(Vec::new()));
        let received_cb = received.clone();
        store
            .spawn_watcher(move |cfg| {
                received_cb.lock().unwrap().push(cfg);
            })
            .expect("watch");

        // Give notify a beat to install its inotify/FSEvents subscription.
        std::thread::sleep(Duration::from_millis(100));

        let mut new_cfg = RelayConfig::default();
        new_cfg.font.size = 18;
        save(&path, &new_cfg).expect("rewrite");

        // Wait up to 3 s for the watcher to fire. Filesystem events on macOS
        // FSEvents can take a few hundred ms; we poll instead of fixed-sleep
        // to keep the suite fast when notify is snappy.
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if !received.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let got = received.lock().unwrap().clone();
        assert!(
            !got.is_empty(),
            "watcher never fired within 3s for {}",
            path.display()
        );
        // Last event must reflect the new size — coalescing may have merged
        // duplicate notifications but the final value wins.
        assert_eq!(got.last().unwrap().font.size, 18);
    }
}
