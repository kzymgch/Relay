//! Tauri-facing bridge for the PTY layer.
//!
//! Responsibilities:
//!
//! - Hold a registry of live `Pty`s keyed by a string pane ID.
//! - Expose `pty_spawn` / `pty_write` / `pty_resize` / `pty_kill` Tauri
//!   commands.
//! - Forward PTY output to the frontend via `pty:data` events, with chunk
//!   coalescing (flush at 32 KB or every 16 ms) to throttle event traffic.
//! - Emit a single `pty:exit` event when the child terminates.
//!
//! The forwarding logic is decoupled from Tauri via the [`EventSink`] trait,
//! which lets us unit-test the spawn/write/forward pipeline without standing
//! up a Tauri runtime.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::pty::{ExitStatus, Pty, PtyConfig, PtyError};
use crate::ssh::{BackoffPolicy, SshAuth, SshConnectConfig, SshSession};
use tokio::sync::oneshot;

/// Default coalescing thresholds for PTY → frontend forwarding.
const FLUSH_BYTES: usize = 32 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// Bracketed paste sequences (xterm DEC mode 2004). When the receiving program
/// has enabled bracketed paste, it sees the wrapped payload as paste data
/// rather than typed input — shells like zsh and bash use this to avoid
/// executing pasted commands immediately. A trailing newline, if requested,
/// goes *after* the close marker so it acts as a deliberate "press Enter"
/// once the paste is finished (this is what iTerm2 and tmux's
/// `send-keys -l ... Enter` do).
pub const BRACKETED_PASTE_START: &[u8] = b"\x1b[200~";
pub const BRACKETED_PASTE_END: &[u8] = b"\x1b[201~";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub const EVENT_DATA: &str = "pty:data";
pub const EVENT_EXIT: &str = "pty:exit";
pub const EVENT_SSH_STATUS: &str = "ssh:status";

/// Stages of an SSH pane's lifecycle. Surfaces in the UI status indicator
/// and drives the Reconnect button's visibility. `attempt` is 1-based; 0 on
/// the very first connection (no retry yet).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SshStatus {
    Connecting,
    Connected,
    Disconnected,
    Reconnecting,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStatusPayload {
    pub pane_id: String,
    pub status: SshStatus,
    pub attempt: u32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDataPayload {
    pub pane_id: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitPayload {
    pub pane_id: String,
    pub code: u32,
    pub success: bool,
}

/// Abstraction over event emission so tests can capture events without a
/// running Tauri instance.
pub trait EventSink: Send + Sync {
    fn emit_data(&self, pane_id: &str, data: Vec<u8>);
    fn emit_exit(&self, pane_id: &str, status: ExitStatus);
    /// SSH lifecycle. Default no-op so existing test sinks compile without
    /// updates; the real Tauri sink overrides this.
    fn emit_ssh_status(&self, _pane_id: &str, _status: SshStatus, _attempt: u32) {}
}

/// Additional per-pane output observer attached to every spawned PTY. Unlike
/// [`EventSink`], `observe` sees **pre-coalesce** raw chunks so subscribers
/// that care about line boundaries (the log writer, the pipe-rule dispatcher)
/// receive output as it arrives from the reader thread. `on_exit` fires
/// before the pane's entry is removed from the registry, which lets sinks
/// flush accumulated state while the source pane is still addressable.
///
/// Sinks must be non-blocking — they run inline on the forward task. Defer
/// expensive work (disk writes, regex matching against a large corpus) onto
/// their own internal task or queue if needed.
pub trait PaneOutputSink: Send + Sync {
    fn observe(&self, pane_id: &str, chunk: &[u8]);
    fn on_exit(&self, pane_id: &str, status: ExitStatus);
}

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_data(&self, pane_id: &str, data: Vec<u8>) {
        let _ = self.app.emit(
            EVENT_DATA,
            PtyDataPayload {
                pane_id: pane_id.into(),
                data,
            },
        );
    }

    fn emit_exit(&self, pane_id: &str, status: ExitStatus) {
        let _ = self.app.emit(
            EVENT_EXIT,
            PtyExitPayload {
                pane_id: pane_id.into(),
                code: status.code,
                success: status.success,
            },
        );
    }

    fn emit_ssh_status(&self, pane_id: &str, status: SshStatus, attempt: u32) {
        let _ = self.app.emit(
            EVENT_SSH_STATUS,
            SshStatusPayload {
                pane_id: pane_id.into(),
                status,
                attempt,
                message: None,
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Inner variant for a registered pane: either a locally spawned `Pty`
/// or an SSH session. Both share the same write / resize / kill surface
/// at this layer; the forward task pipeline doesn't care which is which.
pub enum PaneInner {
    Pty(Arc<Mutex<Pty>>),
    Ssh(Arc<Mutex<SshSession>>),
}

/// Pane registry with per-pane locking.
///
/// The outer `Mutex` only guards the map (lookups + insert/remove of `Arc`s).
/// All real I/O — write, resize, kill — runs under the pane's own inner
/// `Mutex<_>`, so a stuck pane (e.g. a child that has stopped reading its
/// stdin, or an SSH connection whose remote stalled) cannot freeze
/// operations on the other panes.
#[derive(Default)]
pub struct PtyRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    panes: HashMap<String, PaneInner>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inserts a freshly spawned `Pty` under `id`. Errors if `id` is already
    /// taken so callers don't accidentally shadow a live pane.
    fn insert(&self, id: &str, pty: Pty) -> Result<(), PtyError> {
        let mut guard = self.inner.lock().expect("PtyRegistry poisoned");
        if guard.panes.contains_key(id) {
            return Err(PtyError::Pty(format!("pane id already exists: {id}")));
        }
        guard
            .panes
            .insert(id.to_string(), PaneInner::Pty(Arc::new(Mutex::new(pty))));
        Ok(())
    }

    /// Inserts a freshly opened SSH session under `id`. Same uniqueness rule
    /// as `insert` for PTYs.
    pub fn insert_ssh(&self, id: &str, ssh: SshSession) -> Result<(), PtyError> {
        let mut guard = self.inner.lock().expect("PtyRegistry poisoned");
        if guard.panes.contains_key(id) {
            return Err(PtyError::Pty(format!("pane id already exists: {id}")));
        }
        guard
            .panes
            .insert(id.to_string(), PaneInner::Ssh(Arc::new(Mutex::new(ssh))));
        Ok(())
    }

    /// Replace the SSH session backing an existing entry without changing
    /// the pane id. Used by the reconnect loop: the frontend's xterm buffer
    /// and event listeners stay attached because the id is stable.
    pub fn swap_ssh(&self, id: &str, ssh: SshSession) -> Result<(), PtyError> {
        let mut guard = self.inner.lock().expect("PtyRegistry poisoned");
        match guard.panes.get_mut(id) {
            Some(entry @ PaneInner::Ssh(_)) => {
                *entry = PaneInner::Ssh(Arc::new(Mutex::new(ssh)));
                Ok(())
            }
            Some(PaneInner::Pty(_)) => Err(PtyError::Pty(format!(
                "cannot swap ssh into local pane {id}"
            ))),
            None => Err(Self::unknown_id(id)),
        }
    }

    /// Look up the local PTY backing a pane id. Returns `None` for SSH panes
    /// and unknown ids alike — callers who care about that distinction should
    /// branch on `kind` instead.
    pub fn get_pty(&self, id: &str) -> Option<Arc<Mutex<Pty>>> {
        match self
            .inner
            .lock()
            .expect("PtyRegistry poisoned")
            .panes
            .get(id)?
        {
            PaneInner::Pty(p) => Some(p.clone()),
            PaneInner::Ssh(_) => None,
        }
    }

    /// Symmetric with `get_pty` but for SSH-backed panes.
    pub fn get_ssh(&self, id: &str) -> Option<Arc<Mutex<SshSession>>> {
        match self
            .inner
            .lock()
            .expect("PtyRegistry poisoned")
            .panes
            .get(id)?
        {
            PaneInner::Ssh(s) => Some(s.clone()),
            PaneInner::Pty(_) => None,
        }
    }

    /// Is `id` registered to any pane variant?
    pub fn contains(&self, id: &str) -> bool {
        self.inner
            .lock()
            .expect("PtyRegistry poisoned")
            .panes
            .contains_key(id)
    }

    fn take(&self, id: &str) -> Option<PaneInner> {
        self.inner
            .lock()
            .expect("PtyRegistry poisoned")
            .panes
            .remove(id)
    }

    fn unknown_id(id: &str) -> PtyError {
        PtyError::Pty(format!("unknown pty id: {id}"))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), PtyError> {
        let entry = self
            .inner
            .lock()
            .expect("PtyRegistry poisoned")
            .panes
            .get(id)
            .map(clone_inner)
            .ok_or_else(|| Self::unknown_id(id))?;
        match entry {
            PaneInner::Pty(pty) => {
                let mut pty = pty.lock().expect("Pty mutex poisoned");
                pty.write_all(data)
            }
            PaneInner::Ssh(ssh) => {
                let ssh = ssh.lock().expect("SshSession mutex poisoned");
                ssh.write_all(data)
                    .map_err(|e| PtyError::Pty(e.to_string()))
            }
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let entry = self
            .inner
            .lock()
            .expect("PtyRegistry poisoned")
            .panes
            .get(id)
            .map(clone_inner)
            .ok_or_else(|| Self::unknown_id(id))?;
        match entry {
            PaneInner::Pty(pty) => {
                let pty = pty.lock().expect("Pty mutex poisoned");
                pty.resize(cols, rows)
            }
            PaneInner::Ssh(ssh) => {
                let ssh = ssh.lock().expect("SshSession mutex poisoned");
                ssh.resize(cols, rows)
                    .map_err(|e| PtyError::Pty(e.to_string()))
            }
        }
    }

    pub fn kill(&self, id: &str) -> Result<(), PtyError> {
        let entry = self.take(id).ok_or_else(|| Self::unknown_id(id))?;
        match entry {
            PaneInner::Pty(pty) => {
                let mut pty = pty.lock().expect("Pty mutex poisoned");
                pty.kill()
            }
            PaneInner::Ssh(ssh) => {
                let ssh = ssh.lock().expect("SshSession mutex poisoned");
                ssh.kill().map_err(|e| PtyError::Pty(e.to_string()))
            }
        }
    }
}

fn clone_inner(entry: &PaneInner) -> PaneInner {
    match entry {
        PaneInner::Pty(p) => PaneInner::Pty(p.clone()),
        PaneInner::Ssh(s) => PaneInner::Ssh(s.clone()),
    }
}

// ---------------------------------------------------------------------------
// State plugged into Tauri
// ---------------------------------------------------------------------------

pub struct BridgeState {
    pub registry: Arc<PtyRegistry>,
    pub sink: Arc<dyn EventSink>,
    pub observers: Vec<Arc<dyn PaneOutputSink>>,
}

impl BridgeState {
    pub fn new(registry: Arc<PtyRegistry>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            registry,
            sink,
            observers: Vec::new(),
        }
    }

    pub fn with_observers(
        registry: Arc<PtyRegistry>,
        sink: Arc<dyn EventSink>,
        observers: Vec<Arc<dyn PaneOutputSink>>,
    ) -> Self {
        Self {
            registry,
            sink,
            observers,
        }
    }
}

// ---------------------------------------------------------------------------
// Spawning + forwarding
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnConfig {
    /// JS-allocated pane id. Required so the frontend can subscribe to
    /// `pty:data` / `pty:exit` *before* invoking spawn — otherwise events
    /// from short-lived processes (`/bin/echo`, programs that print usage
    /// and exit) emitted between `spawn_pty` returning the id and the
    /// frontend's continuation resuming would be dropped by id filtering.
    pub id: String,
    /// Local command. Required when `ssh` is absent; ignored when `ssh` is
    /// set. Optional in the struct so the frontend can omit it for SSH panes.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// When present, takes the SSH path: open a russh session against the
    /// remote and stream its login shell through the usual `pty:data` /
    /// `pty:exit` pipeline. `command` / `args` / `cwd` / `env` are ignored.
    #[serde(default)]
    pub ssh: Option<SshSpawnConfig>,
}

/// Frontend-supplied SSH connection parameters. `host` is the only required
/// field; everything else falls back to `~/.ssh/config` lookup or sensible
/// defaults (port 22, current user, no key). Plaintext passwords stay on the
/// Rust side: when `useKeychainPassword` is true the backend looks up the
/// password by `<user>@<host>` in the Relay Keychain entry; passwords never
/// cross the IPC boundary.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnConfig {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_path: Option<String>,
    pub ssh_config_alias: Option<String>,
    #[serde(default)]
    pub use_keychain_password: bool,
    #[serde(default = "default_auto_reconnect")]
    pub auto_reconnect: bool,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

fn default_auto_reconnect() -> bool {
    true
}

impl PtySpawnConfig {
    fn into_pty_config(self) -> Result<PtyConfig, PtyError> {
        let command = self
            .command
            .ok_or_else(|| PtyError::Pty("command is required for local panes".into()))?;
        Ok(PtyConfig {
            command,
            args: self.args,
            cwd: self.cwd.map(PathBuf::from),
            env: self.env,
            cols: self.cols,
            rows: self.rows,
            ..Default::default()
        })
    }
}

/// Spawn a new PTY under the caller-supplied `id`. The id must be unique in
/// the registry.
pub async fn spawn_pty(
    registry: Arc<PtyRegistry>,
    sink: Arc<dyn EventSink>,
    observers: Vec<Arc<dyn PaneOutputSink>>,
    id: String,
    config: PtyConfig,
) -> Result<(), PtyError> {
    let mut pty = Pty::spawn(config)?;
    let output_rx = pty
        .take_output_rx()
        .expect("freshly spawned pty must have an output receiver");
    let exit_rx = pty
        .take_exit_rx()
        .expect("freshly spawned pty must have an exit receiver");

    registry.insert(&id, pty)?;

    let registry_for_task = registry.clone();
    let sink_for_task = sink;
    let observers_for_task = observers;
    let id_for_task = id.clone();

    tokio::spawn(async move {
        let exit = drain_until_exit(
            sink_for_task.as_ref(),
            observers_for_task.as_slice(),
            &id_for_task,
            output_rx,
            exit_rx,
        )
        .await;
        // Local PTY panes have no reconnect path, so finalize unconditionally.
        if let Some(status) = exit {
            finalize_pane_exit(
                sink_for_task.as_ref(),
                observers_for_task.as_slice(),
                &id_for_task,
                status,
            );
        }
        let _ = registry_for_task.take(&id_for_task);
    });

    Ok(())
}

/// Forward output chunks to the sink/observers until the source's reader
/// side closes, then await the exit status. **Does not** fire observer
/// `on_exit` callbacks or emit a `pty:exit` event — that's the caller's
/// job. Splitting this out lets the SSH supervisor reuse the data-pumping
/// machinery across reconnect attempts without prematurely telling the
/// frontend (and `onExit` pipe rules) that the pane is gone.
async fn drain_until_exit(
    sink: &dyn EventSink,
    observers: &[Arc<dyn PaneOutputSink>],
    pane_id: &str,
    output_rx: mpsc::Receiver<Vec<u8>>,
    exit_rx: oneshot::Receiver<ExitStatus>,
) -> Option<ExitStatus> {
    forward_loop(sink, observers, pane_id, output_rx).await;
    exit_rx.await.ok()
}

/// Fire `on_exit` on every observer and emit the `pty:exit` event. Called
/// when the pane is truly done — a clean local-PTY exit, a clean SSH
/// logout, a user-initiated kill, or SSH reconnect attempts exhausted.
/// Observers run BEFORE the caller drops the registry entry so onExit pipe
/// rules can still consult the source pane's metadata and call
/// `PtyRegistry::write` on their (still-live) targets.
fn finalize_pane_exit(
    sink: &dyn EventSink,
    observers: &[Arc<dyn PaneOutputSink>],
    pane_id: &str,
    status: ExitStatus,
) {
    for obs in observers {
        obs.on_exit(pane_id, status);
    }
    sink.emit_exit(pane_id, status);
}

// ---------------------------------------------------------------------------
// SSH spawn + reconnect
// ---------------------------------------------------------------------------

/// Per-pane SSH state owned by the reconnect coordinator. Two roles:
///
/// - `notify` lets the frontend's `ssh_reconnect` command interrupt the
///   supervisor's backoff sleep immediately.
/// - `shutdown` lets `pty_kill` (and any other "user really wants this pane
///   gone" path) tell the supervisor not to attempt reconnect — otherwise
///   a manual close while in the middle of a backoff window would race
///   `registry.take()` against `registry.swap_ssh()` and the user would see
///   a futile "reconnecting" status flash before the pane disappeared.
#[derive(Default)]
pub struct SshState {
    inner: Mutex<HashMap<String, PerPane>>,
}

struct PerPane {
    notify: Arc<tokio::sync::Notify>,
    shutdown: bool,
}

impl SshState {
    pub fn new() -> Self {
        Self::default()
    }

    fn slot(&self, id: &str) -> Arc<tokio::sync::Notify> {
        let mut guard = self.inner.lock().expect("SshState poisoned");
        guard
            .entry(id.to_string())
            .or_insert_with(|| PerPane {
                notify: Arc::new(tokio::sync::Notify::new()),
                shutdown: false,
            })
            .notify
            .clone()
    }

    pub fn signal_reconnect(&self, id: &str) {
        let guard = self.inner.lock().expect("SshState poisoned");
        if let Some(s) = guard.get(id) {
            s.notify.notify_waiters();
        }
    }

    /// Mark the pane as being torn down by the user (close button, restart,
    /// app exit). Wakes the backoff sleep so the supervisor can observe the
    /// flag and bail without another reconnect attempt.
    pub fn signal_shutdown(&self, id: &str) {
        let mut guard = self.inner.lock().expect("SshState poisoned");
        if let Some(s) = guard.get_mut(id) {
            s.shutdown = true;
            s.notify.notify_waiters();
        }
    }

    fn is_shutdown(&self, id: &str) -> bool {
        self.inner
            .lock()
            .expect("SshState poisoned")
            .get(id)
            .map(|s| s.shutdown)
            .unwrap_or(false)
    }

    fn drop_slot(&self, id: &str) {
        let mut guard = self.inner.lock().expect("SshState poisoned");
        guard.remove(id);
    }
}

/// Spawn an SSH pane. Opens the initial session, registers it under `id`,
/// and starts the supervisor task that runs forward_loop + reconnect loop.
pub async fn spawn_ssh(
    registry: Arc<PtyRegistry>,
    sink: Arc<dyn EventSink>,
    observers: Vec<Arc<dyn PaneOutputSink>>,
    ssh_state: Arc<SshState>,
    id: String,
    initial: SshConnectConfig,
    auto_reconnect: bool,
) -> Result<(), PtyError> {
    sink.emit_ssh_status(&id, SshStatus::Connecting, 0);
    let mut session = SshSession::connect(initial.clone())
        .await
        .map_err(|e| PtyError::Pty(format!("ssh connect: {e}")))?;
    let output_rx = session.take_output_rx().expect("output rx present");
    let exit_rx = session.take_exit_rx().expect("exit rx present");

    registry.insert_ssh(&id, session)?;
    sink.emit_ssh_status(&id, SshStatus::Connected, 0);

    let registry_for_task = registry.clone();
    let sink_for_task = sink;
    let observers_for_task = observers;
    let ssh_state_for_task = ssh_state.clone();
    let id_for_task = id.clone();

    tokio::spawn(async move {
        ssh_supervisor(
            registry_for_task,
            sink_for_task,
            observers_for_task,
            ssh_state_for_task,
            id_for_task,
            initial,
            output_rx,
            exit_rx,
            auto_reconnect,
        )
        .await;
    });

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn ssh_supervisor(
    registry: Arc<PtyRegistry>,
    sink: Arc<dyn EventSink>,
    observers: Vec<Arc<dyn PaneOutputSink>>,
    ssh_state: Arc<SshState>,
    id: String,
    initial_cfg: SshConnectConfig,
    initial_output_rx: mpsc::Receiver<Vec<u8>>,
    initial_exit_rx: oneshot::Receiver<ExitStatus>,
    auto_reconnect: bool,
) {
    let reconnect_notify = ssh_state.slot(&id);
    let mut current_rx = Some((initial_output_rx, initial_exit_rx));
    let cfg = initial_cfg;

    // The exit status we eventually hand to `finalize_pane_exit`. Holds the
    // *real* status the user should see in the UI — clean shell logout,
    // user kill, or "all retries exhausted" sentinel.
    let final_status: Option<ExitStatus>;

    'outer: loop {
        let (output_rx, exit_rx) = current_rx.take().expect("rx pair present");
        let exit =
            drain_until_exit(sink.as_ref(), observers.as_slice(), &id, output_rx, exit_rx).await;

        let user_kill = ssh_state.is_shutdown(&id);
        // SshSession::pump marks user-initiated kills with `success: true`;
        // network disconnects come back as `success: false` (typically
        // `code = u32::MAX`). A `success: true` exit from the remote shell
        // (user typed `exit`) is also treated as final.
        let clean = exit.map(|s| s.success).unwrap_or(false);

        if !auto_reconnect || clean || user_kill {
            final_status = exit;
            break;
        }

        // Disconnect → reconnect. Crucially: do *not* fire `on_exit`
        // observers or emit `pty:exit` here. The pane is logically still
        // alive; the frontend's `currentPtyId` must stay attached so the
        // upcoming `ssh:status` / `pty:data` events route correctly.
        sink.emit_ssh_status(&id, SshStatus::Disconnected, 0);

        let mut policy = BackoffPolicy::default().iter();
        while let Some((attempt, delay)) = policy.next_attempt() {
            sink.emit_ssh_status(&id, SshStatus::Reconnecting, attempt);
            // Wake either when the backoff elapses or when the user clicks
            // Reconnect — the latter is also how `signal_shutdown` reaches
            // us, in which case `is_shutdown()` returns true below.
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = reconnect_notify.notified() => {}
            }
            if ssh_state.is_shutdown(&id) {
                // User closed the pane during the wait. No reconnect, no
                // synthetic exit emit — the kill path already removed the
                // registry entry and pty:exit fires once below.
                final_status = Some(ExitStatus {
                    code: 0,
                    success: true,
                });
                break 'outer;
            }
            sink.emit_ssh_status(&id, SshStatus::Connecting, attempt);
            match SshSession::connect(cfg.clone()).await {
                Ok(mut session) => {
                    let new_output = session.take_output_rx().expect("output rx present");
                    let new_exit = session.take_exit_rx().expect("exit rx present");
                    if let Err(e) = registry.swap_ssh(&id, session) {
                        // Most likely cause: the entry was removed by a
                        // concurrent `pty_kill`. Treat that as a clean
                        // shutdown — the user wanted this pane gone.
                        eprintln!("relay-ssh: swap_ssh for {id} failed: {e}");
                        final_status = Some(ExitStatus {
                            code: 0,
                            success: true,
                        });
                        break 'outer;
                    }
                    sink.emit_ssh_status(&id, SshStatus::Connected, attempt);
                    current_rx = Some((new_output, new_exit));
                    continue 'outer;
                }
                Err(e) => {
                    eprintln!("relay-ssh: reconnect attempt {attempt} failed: {e}");
                }
            }
        }

        // All attempts exhausted — finalize with a non-success exit so the
        // frontend leaves the reconnecting state and the pane settles into
        // "exited".
        final_status = Some(ExitStatus {
            code: u32::MAX,
            success: false,
        });
        break;
    }

    if let Some(status) = final_status {
        finalize_pane_exit(sink.as_ref(), observers.as_slice(), &id, status);
    }
    let _ = registry.take(&id);
    ssh_state.drop_slot(&id);
}

async fn forward_loop(
    sink: &dyn EventSink,
    observers: &[Arc<dyn PaneOutputSink>],
    pane_id: &str,
    mut rx: mpsc::Receiver<Vec<u8>>,
) {
    let mut pending: Vec<u8> = Vec::new();

    loop {
        // Empty buffer: wait indefinitely for the next chunk.
        if pending.is_empty() {
            match rx.recv().await {
                Some(chunk) => {
                    // Fan out the raw chunk to every observer BEFORE we
                    // accumulate into the coalescing buffer — log writers
                    // and pipe-rule dispatchers want line-accurate input,
                    // not 16 ms-grouped bursts.
                    for obs in observers {
                        obs.observe(pane_id, &chunk);
                    }
                    pending.extend_from_slice(&chunk);
                }
                None => return,
            }
        }

        // If this single chunk already exceeds the threshold, flush it
        // immediately without engaging the coalescing window.
        if pending.len() >= FLUSH_BYTES {
            sink.emit_data(pane_id, std::mem::take(&mut pending));
            continue;
        }

        // Otherwise race more reads against the coalescing deadline.
        let deadline = tokio::time::sleep(FLUSH_INTERVAL);
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                chunk = rx.recv() => match chunk {
                    Some(data) => {
                        for obs in observers {
                            obs.observe(pane_id, &data);
                        }
                        pending.extend_from_slice(&data);
                        if pending.len() >= FLUSH_BYTES {
                            sink.emit_data(pane_id, std::mem::take(&mut pending));
                            break;
                        }
                    }
                    None => {
                        if !pending.is_empty() {
                            sink.emit_data(pane_id, std::mem::take(&mut pending));
                        }
                        return;
                    }
                },
                _ = &mut deadline => {
                    sink.emit_data(pane_id, std::mem::take(&mut pending));
                    break;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pty_spawn(
    state: State<'_, BridgeState>,
    ssh_state: State<'_, Arc<SshState>>,
    config: PtySpawnConfig,
) -> Result<(), String> {
    let id = config.id.clone();
    if let Some(ssh_cfg) = config.ssh.clone() {
        let resolved =
            resolve_ssh_connect(&ssh_cfg, config.cols, config.rows).map_err(|e| e.to_string())?;
        let auto_reconnect = ssh_cfg.auto_reconnect;
        return spawn_ssh(
            state.registry.clone(),
            state.sink.clone(),
            state.observers.clone(),
            ssh_state.inner().clone(),
            id,
            resolved,
            auto_reconnect,
        )
        .await
        .map_err(|e| e.to_string());
    }
    spawn_pty(
        state.registry.clone(),
        state.sink.clone(),
        state.observers.clone(),
        id,
        config.into_pty_config().map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Resolve a frontend-supplied `SshSpawnConfig` against `~/.ssh/config` and
/// Keychain to produce the concrete connect parameters russh needs.
fn resolve_ssh_connect(
    cfg: &SshSpawnConfig,
    cols: u16,
    rows: u16,
) -> Result<SshConnectConfig, String> {
    let default_user = std::env::var("USER").unwrap_or_else(|_| "root".into());
    let ssh_config_text = ssh_config_text();
    let parsed = crate::ssh::SshConfig::parse(&ssh_config_text);
    let target = parsed.resolve(
        &crate::ssh::SshTargetOverride {
            host: cfg.host.clone(),
            port: cfg.port,
            user: cfg.user.clone(),
            identity_path: cfg.identity_path.clone(),
            ssh_config_alias: cfg.ssh_config_alias.clone(),
        },
        &default_user,
    );

    let (lookup_user, lookup_host) = keychain_lookup_identity(cfg, &target);
    let auth = build_ssh_auth(
        &target,
        &lookup_user,
        &lookup_host,
        cfg.use_keychain_password,
    )?;
    Ok(SshConnectConfig {
        host: target.host,
        port: target.port,
        user: target.user,
        auth,
        cols,
        rows,
        term: "xterm-256color".into(),
        ..Default::default()
    })
}

/// Derive the (user, host) pair the Keychain entry is keyed under for an
/// SSH pane.
///
/// The Keychain lookup key must be the *same* identifier the user typed into
/// the storage UI — not the post-`~/.ssh/config`-resolution hostname. With
/// `Host devbox / HostName devbox.internal`, the user stores under
/// `alice@devbox` but `target.host` becomes `devbox.internal`; keying the
/// lookup on `target.host` would miss every aliased pane. We therefore key
/// on the alias (when given) or the literal host, and on the override user
/// (when given) — falling back to the resolved user only because that's
/// also what the storage UI shows as the default when the user leaves the
/// field blank.
///
/// Pure / no I/O so a unit test can pin the contract without touching the
/// real Keychain.
pub(crate) fn keychain_lookup_identity(
    cfg: &SshSpawnConfig,
    target: &crate::ssh::ResolvedSshTarget,
) -> (String, String) {
    let host = cfg
        .ssh_config_alias
        .clone()
        .unwrap_or_else(|| cfg.host.clone());
    let user = cfg.user.clone().unwrap_or_else(|| target.user.clone());
    (user, host)
}

fn ssh_config_text() -> String {
    let path = dirs::home_dir().map(|h| h.join(".ssh").join("config"));
    match path {
        Some(p) => std::fs::read_to_string(p).unwrap_or_default(),
        None => String::new(),
    }
}

fn build_ssh_auth(
    target: &crate::ssh::ResolvedSshTarget,
    lookup_user: &str,
    lookup_host: &str,
    use_keychain_password: bool,
) -> Result<SshAuth, String> {
    let account = crate::ssh::keychain::account_for(lookup_user, lookup_host);
    let keychain_password = if use_keychain_password {
        crate::ssh::keychain::get(&account).map_err(|e| format!("keychain lookup: {e}"))?
    } else {
        None
    };
    match (target.identity_path.as_ref(), keychain_password) {
        // A single Keychain entry serves two roles: passphrase for an
        // encrypted private key, *and* password fallback if the server
        // refuses key auth. Without this, every encrypted key would fail
        // (`load_secret_key(..., None)` can't decrypt) and the user would
        // have to set up plaintext keys to get SSH panes working.
        (Some(path), Some(secret)) => Ok(SshAuth::KeyOrPassword {
            path: path.clone(),
            passphrase: Some(secret.clone()),
            password: secret,
        }),
        (Some(path), None) => Ok(SshAuth::Key {
            path: path.clone(),
            passphrase: None,
        }),
        (None, Some(password)) => Ok(SshAuth::Password(password)),
        (None, None) => Err(format!(
            "no SSH credentials for {} (set IdentityFile in ~/.ssh/config or store a password in Keychain)",
            account
        )),
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, BridgeState>, id: String, data: Vec<u8>) -> Result<(), String> {
    state.registry.write(&id, &data).map_err(|e| e.to_string())
}

/// Build the payload that will be written to the target PTY for an inter-pane
/// send. Kept as a free function so the wrapping policy is unit-testable
/// without standing up a registry.
pub fn build_send_payload(text: &str, bracketed_paste: bool, trailing_newline: bool) -> Vec<u8> {
    let body = text.as_bytes();
    let mut out = Vec::with_capacity(
        body.len()
            + if bracketed_paste {
                BRACKETED_PASTE_START.len() + BRACKETED_PASTE_END.len()
            } else {
                0
            }
            + usize::from(trailing_newline),
    );
    if bracketed_paste {
        out.extend_from_slice(BRACKETED_PASTE_START);
    }
    out.extend_from_slice(body);
    if bracketed_paste {
        out.extend_from_slice(BRACKETED_PASTE_END);
    }
    if trailing_newline {
        out.push(b'\n');
    }
    out
}

/// Send selected text from one pane to another's PTY. Wraps the payload in
/// bracketed paste markers (so the receiver can distinguish paste from typed
/// input) and optionally appends a newline to auto-submit. Both behaviors
/// are user-configurable; defaults match spec §8.
#[tauri::command]
pub fn pty_send_text(
    state: State<'_, BridgeState>,
    id: String,
    text: String,
    bracketed_paste: bool,
    trailing_newline: bool,
) -> Result<(), String> {
    let payload = build_send_payload(&text, bracketed_paste, trailing_newline);
    state
        .registry
        .write(&id, &payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, BridgeState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .registry
        .resize(&id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(
    state: State<'_, BridgeState>,
    ssh_state: State<'_, Arc<SshState>>,
    id: String,
) -> Result<(), String> {
    // For SSH panes, tell the supervisor we want a real teardown before the
    // registry entry disappears. Without this, a kill issued while the
    // supervisor is in its backoff sleep would race: the supervisor would
    // wake, attempt to connect, then fail `swap_ssh` because the entry was
    // already taken — emitting a useless "reconnecting" flash along the way.
    if state.registry.get_ssh(&id).is_some() {
        ssh_state.signal_shutdown(&id);
    }
    state.registry.kill(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// SSH commands
// ---------------------------------------------------------------------------

/// Force an immediate reconnect attempt for an SSH pane. The supervisor's
/// backoff timer is interrupted via a Notify; if the pane isn't currently in
/// the reconnect loop the signal is a no-op (the supervisor will still pick
/// it up on the next disconnect).
#[tauri::command]
pub fn ssh_reconnect(ssh_state: State<'_, Arc<SshState>>, id: String) -> Result<(), String> {
    ssh_state.signal_reconnect(&id);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostAlias {
    pub alias: String,
}

/// Aliases from `~/.ssh/config` for the settings GUI dropdown.
#[tauri::command]
pub fn ssh_config_hosts() -> Result<Vec<SshHostAlias>, String> {
    let parsed = crate::ssh::SshConfig::parse(&ssh_config_text());
    Ok(parsed
        .aliases()
        .into_iter()
        .map(|alias| SshHostAlias { alias })
        .collect())
}

/// Store a password / passphrase in the macOS Keychain under
/// `service = "relay-ssh"`, `account = "<user>@<host>"`. The plaintext never
/// leaves Rust; only `ssh_keychain_has` is provided for read-side checks.
#[tauri::command]
pub fn ssh_keychain_set(user: String, host: String, password: String) -> Result<(), String> {
    let account = crate::ssh::keychain::account_for(&user, &host);
    crate::ssh::keychain::set(&account, &password)
}

#[tauri::command]
pub fn ssh_keychain_has(user: String, host: String) -> Result<bool, String> {
    let account = crate::ssh::keychain::account_for(&user, &host);
    Ok(crate::ssh::keychain::has(&account))
}

#[tauri::command]
pub fn ssh_keychain_delete(user: String, host: String) -> Result<(), String> {
    let account = crate::ssh::keychain::account_for(&user, &host);
    crate::ssh::keychain::delete(&account)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[derive(Debug, Clone)]
    // The bridge unit tests don't currently assert on captured `SshStatus`
    // events — the supervisor's status/exit ordering is exercised end-to-end
    // by the integration test (`supervisor_treats_user_kill_as_clean_shutdown`).
    // The variant exists here so test sinks can faithfully record the event
    // stream without the production code paying a runtime cost.
    #[allow(dead_code)]
    enum TestEvent {
        Data {
            pane_id: String,
            data: Vec<u8>,
        },
        Exit {
            pane_id: String,
            status: ExitStatus,
        },
        SshStatus {
            pane_id: String,
            status: SshStatus,
            attempt: u32,
        },
    }

    #[derive(Default)]
    struct CollectingSink {
        events: Mutex<Vec<TestEvent>>,
    }

    impl CollectingSink {
        fn data_payload_for(&self, id: &str) -> Vec<u8> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    TestEvent::Data { pane_id, data } if pane_id == id => Some(data.clone()),
                    _ => None,
                })
                .flatten()
                .collect()
        }

        fn exit_for(&self, id: &str) -> Option<ExitStatus> {
            self.events.lock().unwrap().iter().find_map(|e| match e {
                TestEvent::Exit { pane_id, status } if pane_id == id => Some(*status),
                _ => None,
            })
        }
    }

    impl EventSink for CollectingSink {
        fn emit_data(&self, pane_id: &str, data: Vec<u8>) {
            self.events.lock().unwrap().push(TestEvent::Data {
                pane_id: pane_id.to_string(),
                data,
            });
        }

        fn emit_exit(&self, pane_id: &str, status: ExitStatus) {
            self.events.lock().unwrap().push(TestEvent::Exit {
                pane_id: pane_id.to_string(),
                status,
            });
        }

        fn emit_ssh_status(&self, pane_id: &str, status: SshStatus, attempt: u32) {
            self.events.lock().unwrap().push(TestEvent::SshStatus {
                pane_id: pane_id.to_string(),
                status,
                attempt,
            });
        }
    }

    async fn wait_for_exit(sink: &CollectingSink, id: &str, max: Duration) -> ExitStatus {
        let deadline = Instant::now() + max;
        while Instant::now() < deadline {
            if let Some(status) = sink.exit_for(id) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("exit event for {id} not observed within {max:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_write_emits_data_and_exit() {
        let registry = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());

        let id = "pane-rw".to_string();
        spawn_pty(
            registry.clone(),
            sink.clone(),
            Vec::new(),
            id.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                args: vec![
                    "-c".into(),
                    "read line; printf 'got=%s\\n' \"$line\"".into(),
                ],
                ..Default::default()
            },
        )
        .await
        .expect("spawn");

        // Inputs go through the registry mutex, just like the Tauri command would.
        registry.write(&id, b"abc\n").expect("write");

        let status = wait_for_exit(&sink, &id, Duration::from_secs(5)).await;
        assert!(status.success, "shell should exit 0, got {status:?}");

        let text = String::from_utf8_lossy(&sink.data_payload_for(&id)).into_owned();
        assert!(
            text.contains("got=abc"),
            "data events did not carry child output, got {text:?}"
        );

        // The registry entry is cleaned up once the forward task finishes.
        assert!(
            !registry.contains(&id),
            "registry should drop completed pane {id}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forward_loop_coalesces_small_bursts_within_interval() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>(8);
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let sink_for_task = sink.clone();
        let task = tokio::spawn(async move {
            forward_loop(sink_for_task.as_ref(), &[], "pane-x", rx).await;
        });

        // Three small writes in quick succession should be merged into a
        // single emission by the FLUSH_INTERVAL coalescing.
        tx.send(b"a".to_vec()).await.unwrap();
        tx.send(b"b".to_vec()).await.unwrap();
        tx.send(b"c".to_vec()).await.unwrap();
        // Allow the deadline to fire.
        tokio::time::sleep(Duration::from_millis(40)).await;
        drop(tx);
        task.await.unwrap();

        let events = sink.events.lock().unwrap();
        let data_events: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                TestEvent::Data { pane_id, data } if pane_id == "pane-x" => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            data_events.len(),
            1,
            "expected one coalesced emit, got {data_events:?}"
        );
        assert_eq!(&data_events[0], b"abc");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forward_loop_flushes_threshold_independently_of_tail() {
        // If threshold-crossing flushes are immediate, a >FLUSH_BYTES chunk
        // followed by a small tail must emit two distinct events. If the
        // forward loop instead waited for the coalescing deadline, both
        // chunks would merge into one event.
        let (tx, rx) = mpsc::channel::<Vec<u8>>(4);
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let sink_for_task = sink.clone();
        let task = tokio::spawn(async move {
            forward_loop(sink_for_task.as_ref(), &[], "pane-y", rx).await;
        });

        let big = vec![b'A'; FLUSH_BYTES + 1];
        tx.send(big.clone()).await.unwrap();
        // Yield long enough for the threshold flush to land before the next
        // send, but well under FLUSH_INTERVAL so coalescing would merge if it
        // were the active path.
        tokio::time::sleep(Duration::from_millis(5)).await;
        tx.send(b"tail".to_vec()).await.unwrap();
        // Let the tail's coalescing window expire.
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(tx);
        task.await.unwrap();

        let events = sink.events.lock().unwrap();
        let data_events: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                TestEvent::Data { pane_id, data } if pane_id == "pane-y" => Some(data.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            data_events.len(),
            2,
            "expected threshold flush then tail flush, got {} events",
            data_events.len()
        );
        assert_eq!(
            data_events[0], big,
            "first emit should be the threshold chunk"
        );
        assert_eq!(
            data_events[1], b"tail",
            "second emit should be the coalesced tail"
        );
    }

    // The std::sync::MutexGuard for pane A is intentionally held across an
    // `.await`. The awaited futures only poll a JoinHandle whose underlying
    // work runs on tokio's blocking thread pool, so this cannot deadlock the
    // runtime — clippy's heuristic doesn't have that context.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test(flavor = "current_thread")]
    async fn per_pane_lock_isolates_blocking_io() {
        // Hold pane A's inner Mutex<Pty> — equivalent to A being stuck in a
        // long-running write_all/flush. We then assert two properties:
        //
        //   1. A blocking write on the same pane really does stall while the
        //      lock is held (sanity check that the simulation works).
        //   2. Operations on a different pane (kill B) complete quickly,
        //      proving the registry's outer lock is not held during inner
        //      pane I/O.
        let registry = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());

        let a = "pane-a".to_string();
        spawn_pty(
            registry.clone(),
            sink.clone(),
            Vec::new(),
            a.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                ..Default::default()
            },
        )
        .await
        .expect("spawn A");

        let b = "pane-b".to_string();
        spawn_pty(
            registry.clone(),
            sink.clone(),
            Vec::new(),
            b.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                ..Default::default()
            },
        )
        .await
        .expect("spawn B");

        let pty_a = registry.get_pty(&a).expect("pane A in registry");
        let guard_a = pty_a.lock().expect("lock A");

        // Sanity: write on A is blocked while the inner mutex is held.
        let registry_for_a = registry.clone();
        let a_for_blocking = a.clone();
        let mut blocked_write =
            tokio::task::spawn_blocking(move || registry_for_a.write(&a_for_blocking, b"hi"));
        let stalled = tokio::time::timeout(Duration::from_millis(200), &mut blocked_write).await;
        assert!(
            stalled.is_err(),
            "write on a locked pane should block, but it returned {stalled:?}"
        );

        // The actual invariant: kill on a different pane must not be blocked
        // behind A's lock.
        let start = Instant::now();
        registry
            .kill(&b)
            .expect("kill B should not be blocked by A");
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(500),
            "kill on pane B took {elapsed:?} while pane A's lock was held"
        );

        // Releasing A's lock lets the previously-blocked write finish.
        drop(guard_a);
        let _ = tokio::time::timeout(Duration::from_secs(2), blocked_write)
            .await
            .expect("blocked write should resume once A's lock is released");

        let _ = registry.kill(&a);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn spawn_with_duplicate_id_errors() {
        // Frontend allocates ids before spawning, so the bridge must refuse
        // to shadow an existing pane. Catches a stale id being reused after
        // a pane was thought to be dead but is actually still in the
        // registry.
        let registry = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let id = "pane-dup".to_string();

        spawn_pty(
            registry.clone(),
            sink.clone(),
            Vec::new(),
            id.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                ..Default::default()
            },
        )
        .await
        .expect("first spawn");

        let err = spawn_pty(
            registry.clone(),
            sink.clone(),
            Vec::new(),
            id.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                ..Default::default()
            },
        )
        .await
        .expect_err("second spawn must error");
        assert!(
            err.to_string().contains("already exists"),
            "expected duplicate id error, got {err:?}"
        );

        let _ = registry.kill(&id);
    }

    #[test]
    fn kill_on_unknown_id_returns_error() {
        // Kill should match the API surface of write / resize: an unknown
        // pane id is an error, not a silent no-op. That gives the frontend
        // a way to detect stale ids and double-kills.
        let registry = PtyRegistry::new();
        let err = registry
            .kill("pane-does-not-exist")
            .expect_err("expected error");
        let msg = err.to_string();
        assert!(
            msg.contains("unknown pty id"),
            "expected 'unknown pty id' in error, got {msg:?}"
        );
    }

    #[test]
    fn build_send_payload_wraps_bracketed_paste() {
        // Bracketed paste mode (DEC 2004) requires the payload to be enclosed
        // in CSI 200 ~ / CSI 201 ~ so the receiver can distinguish pasted
        // bytes from typed input.
        let bytes = build_send_payload("hello", true, false);
        assert_eq!(bytes, b"\x1b[200~hello\x1b[201~");
    }

    #[test]
    fn build_send_payload_appends_newline_outside_markers() {
        // The trailing newline lives *after* the close marker so the receiver
        // treats it as a deliberate "press Enter" once paste mode has exited.
        // If it were inside the markers it would be processed as part of the
        // pasted text, defeating the auto-submit affordance.
        let bytes = build_send_payload("ls", true, true);
        assert_eq!(bytes, b"\x1b[200~ls\x1b[201~\n");
    }

    #[test]
    fn build_send_payload_without_bracketed_paste_is_raw() {
        // Opt-out path: some shells / programs do not understand bracketed
        // paste and the user expects the bytes verbatim.
        let bytes = build_send_payload("ping", false, true);
        assert_eq!(bytes, b"ping\n");
    }

    #[test]
    fn build_send_payload_empty_text_still_wraps() {
        // Sending an empty selection should still produce a well-formed
        // bracketed-paste burst so the receiver doesn't enter a half-open
        // state. The frontend will typically suppress empty sends, but the
        // backend must not corrupt the stream if one slips through.
        let bytes = build_send_payload("", true, false);
        assert_eq!(bytes, b"\x1b[200~\x1b[201~");
    }

    #[test]
    fn build_send_payload_preserves_inner_newlines() {
        // Multi-line selections must reach the receiver as a single bracketed
        // burst — splitting on '\n' would let the shell execute each line.
        let bytes = build_send_payload("a\nb\nc", true, false);
        assert_eq!(bytes, b"\x1b[200~a\nb\nc\x1b[201~");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_text_delivers_bracketed_payload_to_child() {
        // End-to-end through the registry: with PTY echo enabled, the
        // line-discipline echoes the bytes we wrote back through the master,
        // and we observe them in the data sink. This proves the bracketed
        // paste framing reaches the slave intact — no chunking, no escape
        // mangling. We kill the child once we've seen the markers rather
        // than relying on a child that reads a fixed-size input.
        let registry = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());

        let id = "pane-send".to_string();
        spawn_pty(
            registry.clone(),
            sink.clone(),
            Vec::new(),
            id.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                // `cat` runs until stdin EOF — we kill it explicitly after
                // asserting on the echoed bytes.
                args: vec!["-c".into(), "cat".into()],
                ..Default::default()
            },
        )
        .await
        .expect("spawn");

        let payload = build_send_payload("hi", true, true);
        registry.write(&id, &payload).expect("write");

        // Poll the sink until both markers are present, or time out. We
        // can't synchronously await the data event because forward_loop
        // coalesces with a small delay.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let raw = sink.data_payload_for(&id);
            let has_start = raw
                .windows(BRACKETED_PASTE_START.len())
                .any(|w| w == BRACKETED_PASTE_START);
            let has_end = raw
                .windows(BRACKETED_PASTE_END.len())
                .any(|w| w == BRACKETED_PASTE_END);
            if has_start && has_end {
                let text = String::from_utf8_lossy(&raw).into_owned();
                assert!(text.contains("hi"), "missing payload body in {text:?}");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "did not observe bracketed-paste markers; sink={:?}",
                String::from_utf8_lossy(&raw)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // Tear down so the forward task drains and the test process can exit.
        registry.kill(&id).expect("kill");
        let _ = wait_for_exit(&sink, &id, Duration::from_secs(5)).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn three_panes_run_simultaneously() {
        // PR-07 mounts three panes at startup. Verify the bridge can host
        // three concurrent spawns: distinct ids, each child gets its own
        // output stream, and all complete successfully.
        let registry = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());

        let (id1, id2, id3) = (
            "pane-1".to_string(),
            "pane-2".to_string(),
            "pane-3".to_string(),
        );

        let (r1, r2, r3) = tokio::join!(
            spawn_pty(
                registry.clone(),
                sink.clone(),
                Vec::new(),
                id1.clone(),
                PtyConfig {
                    command: "/bin/echo".into(),
                    args: vec!["pane1".into()],
                    ..Default::default()
                },
            ),
            spawn_pty(
                registry.clone(),
                sink.clone(),
                Vec::new(),
                id2.clone(),
                PtyConfig {
                    command: "/bin/echo".into(),
                    args: vec!["pane2".into()],
                    ..Default::default()
                },
            ),
            spawn_pty(
                registry.clone(),
                sink.clone(),
                Vec::new(),
                id3.clone(),
                PtyConfig {
                    command: "/bin/echo".into(),
                    args: vec!["pane3".into()],
                    ..Default::default()
                },
            ),
        );

        r1.expect("spawn pane1");
        r2.expect("spawn pane2");
        r3.expect("spawn pane3");

        // IDs must be unique so the frontend can route data/exit events.
        assert_ne!(id1, id2);
        assert_ne!(id2, id3);
        assert_ne!(id1, id3);

        for id in [&id1, &id2, &id3] {
            let status = wait_for_exit(&sink, id, Duration::from_secs(5)).await;
            assert!(status.success, "{id} should exit 0, got {status:?}");
        }

        let text1 = String::from_utf8_lossy(&sink.data_payload_for(&id1)).into_owned();
        let text2 = String::from_utf8_lossy(&sink.data_payload_for(&id2)).into_owned();
        let text3 = String::from_utf8_lossy(&sink.data_payload_for(&id3)).into_owned();

        assert!(text1.contains("pane1"), "{id1} output: {text1:?}");
        assert!(text2.contains("pane2"), "{id2} output: {text2:?}");
        assert!(text3.contains("pane3"), "{id3} output: {text3:?}");

        // Output must not leak across panes.
        assert!(!text1.contains("pane2"));
        assert!(!text1.contains("pane3"));
        assert!(!text2.contains("pane1"));
        assert!(!text3.contains("pane1"));
    }

    // ---------------------------------------------------------------------
    // PaneOutputSink — pre-coalesce fan-out and exit-before-removal
    // ---------------------------------------------------------------------

    #[derive(Default)]
    struct CollectingObserver {
        chunks: Mutex<Vec<(String, Vec<u8>)>>,
        exits: Mutex<Vec<(String, ExitStatus)>>,
        registry_known_at_exit: Mutex<Vec<(String, bool)>>,
        watch_registry: Mutex<Option<Arc<PtyRegistry>>>,
    }

    impl PaneOutputSink for CollectingObserver {
        fn observe(&self, pane_id: &str, chunk: &[u8]) {
            self.chunks
                .lock()
                .unwrap()
                .push((pane_id.to_string(), chunk.to_vec()));
        }

        fn on_exit(&self, pane_id: &str, status: ExitStatus) {
            if let Some(reg) = self.watch_registry.lock().unwrap().as_ref() {
                self.registry_known_at_exit
                    .lock()
                    .unwrap()
                    .push((pane_id.to_string(), reg.contains(pane_id)));
            }
            self.exits
                .lock()
                .unwrap()
                .push((pane_id.to_string(), status));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forward_loop_fans_out_to_all_observers_pre_coalesce() {
        // The observer sees every raw chunk individually, while the frontend
        // EventSink only sees the coalesced flush. Proves logging / pipe
        // can rely on per-line input even though the UI sees 16 ms bursts.
        let (tx, rx) = mpsc::channel::<Vec<u8>>(8);
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let obs: Arc<CollectingObserver> = Arc::new(CollectingObserver::default());
        let observers: Vec<Arc<dyn PaneOutputSink>> = vec![obs.clone()];

        let sink_for_task = sink.clone();
        let observers_for_task = observers.clone();
        let task = tokio::spawn(async move {
            forward_loop(
                sink_for_task.as_ref(),
                observers_for_task.as_slice(),
                "pane-fan",
                rx,
            )
            .await;
        });

        tx.send(b"alpha\n".to_vec()).await.unwrap();
        tx.send(b"beta\n".to_vec()).await.unwrap();
        tx.send(b"gamma\n".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        drop(tx);
        task.await.unwrap();

        // Observer saw all three chunks as separate entries.
        let chunks = obs.chunks.lock().unwrap().clone();
        assert_eq!(chunks.len(), 3, "observer should see 3 raw chunks");
        assert_eq!(chunks[0].1, b"alpha\n".to_vec());
        assert_eq!(chunks[1].1, b"beta\n".to_vec());
        assert_eq!(chunks[2].1, b"gamma\n".to_vec());

        // Frontend sink saw them coalesced into a single flush.
        let merged = sink.data_payload_for("pane-fan");
        assert_eq!(merged, b"alpha\nbeta\ngamma\n".to_vec());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn observer_on_exit_fires_before_registry_removal() {
        // Sinks must be able to consult the source pane's registry entry from
        // on_exit so onExit pipe rules can call write() on the *target* pane
        // before the source is dropped. We check this by having the observer
        // record whether `registry.get(pane_id)` resolves at on_exit time.
        let registry = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let obs: Arc<CollectingObserver> = Arc::new(CollectingObserver::default());
        *obs.watch_registry.lock().unwrap() = Some(registry.clone());
        let observers: Vec<Arc<dyn PaneOutputSink>> = vec![obs.clone()];

        let id = "pane-onexit".to_string();
        spawn_pty(
            registry.clone(),
            sink.clone(),
            observers,
            id.clone(),
            PtyConfig {
                command: "/bin/echo".into(),
                args: vec!["bye".into()],
                ..Default::default()
            },
        )
        .await
        .expect("spawn");

        // Wait for the exit event so we know the forward task has finished
        // emitting `on_exit` for the observer.
        let _ = wait_for_exit(&sink, &id, Duration::from_secs(5)).await;

        // The observer's `registry_known_at_exit` records one entry per
        // on_exit; for the source pane that entry must be `true`.
        let known = obs.registry_known_at_exit.lock().unwrap().clone();
        let our = known
            .iter()
            .find(|(p, _)| p == &id)
            .expect("on_exit fired for pane");
        assert!(
            our.1,
            "registry must still hold the source pane when on_exit fires"
        );

        // Sanity: by the time the frontend sees pty:exit the registry IS
        // emptied.
        assert!(
            !registry.contains(&id),
            "registry should drop the source pane after exit is fully processed"
        );
    }

    // -----------------------------------------------------------------
    // Keychain account-key derivation
    //
    // Pins the contract that the lookup key matches the *user-facing*
    // identifier — what they typed into the storage UI — rather than the
    // post-ssh_config-resolution hostname. A regression here silently
    // bypasses every aliased SSH pane's stored password.
    // -----------------------------------------------------------------

    fn default_target(user: &str, host: &str) -> crate::ssh::ResolvedSshTarget {
        crate::ssh::ResolvedSshTarget {
            host: host.to_string(),
            port: 22,
            user: user.to_string(),
            identity_path: None,
        }
    }

    fn ssh_spawn_cfg(host: &str) -> SshSpawnConfig {
        SshSpawnConfig {
            host: host.into(),
            port: None,
            user: None,
            identity_path: None,
            ssh_config_alias: None,
            use_keychain_password: false,
            auto_reconnect: true,
        }
    }

    #[test]
    fn keychain_lookup_uses_alias_not_resolved_hostname() {
        // The user stored the password under `alice@devbox` via the storage
        // UI. The pane spec carries `ssh_config_alias = "devbox"` and the
        // alias resolves to `HostName devbox.internal.example.com`. The
        // lookup must still key on `devbox`, otherwise no password would
        // ever match for aliased panes.
        let cfg = SshSpawnConfig {
            user: Some("alice".into()),
            ssh_config_alias: Some("devbox".into()),
            ..ssh_spawn_cfg("devbox")
        };
        let target = default_target("alice", "devbox.internal.example.com");
        let (user, host) = keychain_lookup_identity(&cfg, &target);
        assert_eq!(user, "alice");
        assert_eq!(
            host, "devbox",
            "lookup host must match the alias the user stored under, not the resolved HostName"
        );
    }

    #[test]
    fn keychain_lookup_uses_literal_host_when_no_alias() {
        // Direct-host pane (no alias). User stored under
        // `alice@10.0.0.1`; ssh_config may or may not have a wildcard
        // entry but it shouldn't change the lookup identifier.
        let cfg = SshSpawnConfig {
            user: Some("alice".into()),
            ..ssh_spawn_cfg("10.0.0.1")
        };
        let target = default_target("alice", "10.0.0.1");
        let (user, host) = keychain_lookup_identity(&cfg, &target);
        assert_eq!(user, "alice");
        assert_eq!(host, "10.0.0.1");
    }

    #[test]
    fn keychain_lookup_user_override_wins_over_resolved_user() {
        // If the pane spec specifies a user, the lookup must use it even
        // when ssh_config's `User` block would resolve to something else.
        // Otherwise a single host with multiple Keychain entries (per OS
        // user) wouldn't be addressable.
        let cfg = SshSpawnConfig {
            user: Some("alice".into()),
            ssh_config_alias: Some("devbox".into()),
            ..ssh_spawn_cfg("devbox")
        };
        // ssh_config resolved to a different user (e.g. `User bob` in the
        // Host block). We must still look up alice.
        let target = default_target("bob", "devbox.internal.example.com");
        let (user, host) = keychain_lookup_identity(&cfg, &target);
        assert_eq!(user, "alice");
        assert_eq!(host, "devbox");
    }

    #[test]
    fn keychain_lookup_falls_back_to_resolved_user_when_no_override() {
        // No `user` in the pane spec — the storage UI would show the
        // default OS user (the same `default_user` ssh_config falls back
        // to), so the lookup uses that too.
        let cfg = SshSpawnConfig {
            ssh_config_alias: Some("devbox".into()),
            ..ssh_spawn_cfg("devbox")
        };
        let target = default_target("default-user", "devbox.internal.example.com");
        let (user, host) = keychain_lookup_identity(&cfg, &target);
        assert_eq!(user, "default-user");
        assert_eq!(host, "devbox");
    }
}
