//! SSH support: remote panes that share the same channel shape as local PTYs.
//!
//! Submodules:
//! - `client` — russh wrapper exposing `output_rx` / `exit_rx` mpsc + oneshot
//!   so the bridge's forward loop runs unchanged.
//! - `config` — minimal `~/.ssh/config` parser (Host blocks, HostName, User,
//!   Port, IdentityFile).
//! - `keychain` — macOS Keychain wrapper for stored passwords / key
//!   passphrases.
//! - `reconnect` — exponential-backoff retry policy used by the bridge's
//!   SSH reconnect loop.

pub mod client;
pub mod config;
pub mod keychain;
pub mod reconnect;

pub use client::{SshAuth, SshConnectConfig, SshError, SshSession};
pub use config::{ResolvedSshTarget, SshConfig, SshTargetOverride};
pub use reconnect::{BackoffIter, BackoffPolicy};
