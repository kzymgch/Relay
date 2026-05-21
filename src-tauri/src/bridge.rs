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

/// Default coalescing thresholds for PTY → frontend forwarding.
const FLUSH_BYTES: usize = 32 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub const EVENT_DATA: &str = "pty:data";
pub const EVENT_EXIT: &str = "pty:exit";

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
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct PtyRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    next_id: u64,
    ptys: HashMap<String, Pty>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn allocate_id(&self) -> String {
        let mut guard = self.inner.lock().expect("PtyRegistry poisoned");
        guard.next_id += 1;
        format!("pane-{}", guard.next_id)
    }

    fn insert(&self, id: &str, pty: Pty) {
        self.inner
            .lock()
            .expect("PtyRegistry poisoned")
            .ptys
            .insert(id.to_string(), pty);
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), PtyError> {
        let mut guard = self.inner.lock().expect("PtyRegistry poisoned");
        let pty = guard
            .ptys
            .get_mut(id)
            .ok_or_else(|| PtyError::Pty(format!("unknown pty id: {id}")))?;
        pty.write_all(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let guard = self.inner.lock().expect("PtyRegistry poisoned");
        let pty = guard
            .ptys
            .get(id)
            .ok_or_else(|| PtyError::Pty(format!("unknown pty id: {id}")))?;
        pty.resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> Result<(), PtyError> {
        let mut guard = self.inner.lock().expect("PtyRegistry poisoned");
        if let Some(mut pty) = guard.ptys.remove(id) {
            pty.kill()?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State plugged into Tauri
// ---------------------------------------------------------------------------

pub struct BridgeState {
    pub registry: Arc<PtyRegistry>,
    pub sink: Arc<dyn EventSink>,
}

impl BridgeState {
    pub fn new(registry: Arc<PtyRegistry>, sink: Arc<dyn EventSink>) -> Self {
        Self { registry, sink }
    }
}

// ---------------------------------------------------------------------------
// Spawning + forwarding
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

impl From<PtySpawnConfig> for PtyConfig {
    fn from(value: PtySpawnConfig) -> Self {
        Self {
            command: value.command,
            args: value.args,
            cwd: value.cwd.map(PathBuf::from),
            env: value.env,
            cols: value.cols,
            rows: value.rows,
            ..Default::default()
        }
    }
}

pub async fn spawn_pty(
    registry: Arc<PtyRegistry>,
    sink: Arc<dyn EventSink>,
    config: PtyConfig,
) -> Result<String, PtyError> {
    let mut pty = Pty::spawn(config)?;
    let output_rx = pty
        .take_output_rx()
        .expect("freshly spawned pty must have an output receiver");
    let exit_rx = pty
        .take_exit_rx()
        .expect("freshly spawned pty must have an exit receiver");

    let id = registry.allocate_id();
    registry.insert(&id, pty);

    let registry_for_task = registry.clone();
    let sink_for_task = sink;
    let id_for_task = id.clone();

    tokio::spawn(async move {
        forward_loop(sink_for_task.as_ref(), &id_for_task, output_rx).await;
        if let Ok(status) = exit_rx.await {
            sink_for_task.emit_exit(&id_for_task, status);
        }
        // Drop the registry entry once the child is gone so panes don't leak.
        let mut guard = registry_for_task
            .inner
            .lock()
            .expect("PtyRegistry poisoned");
        guard.ptys.remove(&id_for_task);
    });

    Ok(id)
}

async fn forward_loop(sink: &dyn EventSink, pane_id: &str, mut rx: mpsc::Receiver<Vec<u8>>) {
    let mut pending: Vec<u8> = Vec::new();

    loop {
        // Empty buffer: wait indefinitely for the next chunk.
        if pending.is_empty() {
            match rx.recv().await {
                Some(chunk) => pending.extend_from_slice(&chunk),
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
    config: PtySpawnConfig,
) -> Result<String, String> {
    spawn_pty(state.registry.clone(), state.sink.clone(), config.into())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_write(state: State<'_, BridgeState>, id: String, data: Vec<u8>) -> Result<(), String> {
    state.registry.write(&id, &data).map_err(|e| e.to_string())
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
pub fn pty_kill(state: State<'_, BridgeState>, id: String) -> Result<(), String> {
    state.registry.kill(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[derive(Debug, Clone)]
    enum TestEvent {
        Data { pane_id: String, data: Vec<u8> },
        Exit { pane_id: String, status: ExitStatus },
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

        let id = spawn_pty(
            registry.clone(),
            sink.clone(),
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
        let inner = registry.inner.lock().unwrap();
        assert!(
            !inner.ptys.contains_key(&id),
            "registry should drop completed pane {id}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forward_loop_coalesces_small_bursts_within_interval() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>(8);
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let sink_for_task = sink.clone();
        let task = tokio::spawn(async move {
            forward_loop(sink_for_task.as_ref(), "pane-x", rx).await;
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
            forward_loop(sink_for_task.as_ref(), "pane-y", rx).await;
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
}
