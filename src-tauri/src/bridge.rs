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

/// Pane registry with per-pane locking.
///
/// The outer `Mutex` only guards the map (lookups + insert/remove of `Arc`s).
/// All real PTY I/O — write, resize, kill — runs under the pane's own inner
/// `Mutex<Pty>`, so a stuck PTY (e.g. a child that has stopped reading its
/// stdin) cannot freeze operations on the other panes.
#[derive(Default)]
pub struct PtyRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    next_id: u64,
    ptys: HashMap<String, Arc<Mutex<Pty>>>,
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
            .insert(id.to_string(), Arc::new(Mutex::new(pty)));
    }

    fn get(&self, id: &str) -> Option<Arc<Mutex<Pty>>> {
        self.inner
            .lock()
            .expect("PtyRegistry poisoned")
            .ptys
            .get(id)
            .cloned()
    }

    fn take(&self, id: &str) -> Option<Arc<Mutex<Pty>>> {
        self.inner
            .lock()
            .expect("PtyRegistry poisoned")
            .ptys
            .remove(id)
    }

    fn unknown_id(id: &str) -> PtyError {
        PtyError::Pty(format!("unknown pty id: {id}"))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), PtyError> {
        let pty = self.get(id).ok_or_else(|| Self::unknown_id(id))?;
        let mut pty = pty.lock().expect("Pty mutex poisoned");
        pty.write_all(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let pty = self.get(id).ok_or_else(|| Self::unknown_id(id))?;
        let pty = pty.lock().expect("Pty mutex poisoned");
        pty.resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> Result<(), PtyError> {
        let pty = self.take(id).ok_or_else(|| Self::unknown_id(id))?;
        let mut pty = pty.lock().expect("Pty mutex poisoned");
        pty.kill()
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
        let exit = exit_rx.await.ok();
        // Drop the registry entry BEFORE emitting `pty:exit` so any observer
        // that reacts to the event can rely on the invariant that the pane
        // is gone from the registry.
        let _ = registry_for_task.take(&id_for_task);
        if let Some(status) = exit {
            sink_for_task.emit_exit(&id_for_task, status);
        }
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

        let a = spawn_pty(
            registry.clone(),
            sink.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                ..Default::default()
            },
        )
        .await
        .expect("spawn A");

        let b = spawn_pty(
            registry.clone(),
            sink.clone(),
            PtyConfig {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 5".into()],
                ..Default::default()
            },
        )
        .await
        .expect("spawn B");

        let pty_a = registry.get(&a).expect("pane A in registry");
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

    #[tokio::test(flavor = "current_thread")]
    async fn three_panes_run_simultaneously() {
        // PR-07 mounts three panes at startup. Verify the bridge can host
        // three concurrent spawns: distinct ids, each child gets its own
        // output stream, and all complete successfully.
        let registry = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());

        let (id1, id2, id3) = tokio::join!(
            spawn_pty(
                registry.clone(),
                sink.clone(),
                PtyConfig {
                    command: "/bin/echo".into(),
                    args: vec!["pane1".into()],
                    ..Default::default()
                },
            ),
            spawn_pty(
                registry.clone(),
                sink.clone(),
                PtyConfig {
                    command: "/bin/echo".into(),
                    args: vec!["pane2".into()],
                    ..Default::default()
                },
            ),
            spawn_pty(
                registry.clone(),
                sink.clone(),
                PtyConfig {
                    command: "/bin/echo".into(),
                    args: vec!["pane3".into()],
                    ..Default::default()
                },
            ),
        );

        let id1 = id1.expect("spawn pane1");
        let id2 = id2.expect("spawn pane2");
        let id3 = id3.expect("spawn pane3");

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
}
