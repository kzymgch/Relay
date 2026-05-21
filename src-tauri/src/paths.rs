//! Filesystem path helpers for Relay's on-disk state.
//!
//! Layout under the config directory:
//!
//! ```text
//! $XDG_CONFIG_HOME/relay/          (fallback: ~/.config/relay/)
//! ├── config.toml                  ← user-editable settings
//! ├── autosave.json                ← previous-session snapshot
//! └── sessions/
//!     ├── <name>.json              ← one named session per file
//!     └── <name>.scrollback/
//!         └── <paneId>.bin         ← opt-in, size-capped
//! ```
//!
//! All paths run through the helpers below so tests can redirect them with
//! the `RELAY_CONFIG_DIR` env var. Production code never reads `$HOME`
//! directly.

use std::path::PathBuf;

/// Env var that overrides the config root — used by tests to point at a
/// `tempfile::TempDir`. Empty / missing means "use the OS default".
const ENV_OVERRIDE: &str = "RELAY_CONFIG_DIR";

/// Returns the directory that holds `config.toml`, `sessions/`, etc.
///
/// In production this is `$XDG_CONFIG_HOME/relay` (or `~/.config/relay` on
/// platforms without XDG). On macOS the `dirs` crate maps this to
/// `~/Library/Application Support/relay` — we override that to keep the
/// spec's `~/.config/relay/config.toml` path stable across platforms.
pub fn config_dir() -> PathBuf {
    if let Some(over) = std::env::var_os(ENV_OVERRIDE) {
        if !over.is_empty() {
            return PathBuf::from(over);
        }
    }
    // Prefer the explicit XDG path (and the manual `~/.config` fallback) so
    // every OS lands on the same disk layout as documented in the spec.
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("relay");
        }
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".config").join("relay");
    }
    // Last-resort fallback so tests on CI without a home dir still work.
    PathBuf::from(".relay")
}

pub fn config_file() -> PathBuf {
    config_dir().join("config.toml")
}

pub fn autosave_file() -> PathBuf {
    config_dir().join("autosave.json")
}

pub fn sessions_dir() -> PathBuf {
    config_dir().join("sessions")
}

pub fn session_file(name: &str) -> PathBuf {
    sessions_dir().join(format!("{name}.json"))
}

pub fn scrollback_dir(name: &str) -> PathBuf {
    sessions_dir().join(format!("{name}.scrollback"))
}

pub fn logs_dir() -> PathBuf {
    config_dir().join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke: `RELAY_CONFIG_DIR` overrides every derived path.
    #[test]
    fn override_env_redirects_all_paths() {
        let prev = std::env::var_os(ENV_OVERRIDE);
        // SAFETY: tests run single-threaded for this module; we restore below.
        std::env::set_var(ENV_OVERRIDE, "/tmp/relay-test-root");
        assert_eq!(config_dir(), PathBuf::from("/tmp/relay-test-root"));
        assert_eq!(
            config_file(),
            PathBuf::from("/tmp/relay-test-root/config.toml")
        );
        assert_eq!(
            autosave_file(),
            PathBuf::from("/tmp/relay-test-root/autosave.json")
        );
        assert_eq!(
            sessions_dir(),
            PathBuf::from("/tmp/relay-test-root/sessions")
        );
        assert_eq!(
            session_file("morning"),
            PathBuf::from("/tmp/relay-test-root/sessions/morning.json")
        );
        match prev {
            Some(v) => std::env::set_var(ENV_OVERRIDE, v),
            None => std::env::remove_var(ENV_OVERRIDE),
        }
    }
}
