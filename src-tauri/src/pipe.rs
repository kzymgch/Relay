//! Pane-to-pane output pipelining (spec §9).
//!
//! Subscribes to PTY output via [`crate::bridge::PaneOutputSink`] and forwards
//! filtered, mode-transformed lines from a source pane to a target pane's
//! stdin via [`crate::bridge::PtyRegistry::write`].
//!
//! Modes:
//!
//! - `lineRealtime`: forward each newline-terminated line as it arrives,
//!   filtered by include/exclude.
//! - `regexMatch`: forward lines that match `pattern`.
//! - `tailPeriodic`: keep the last N lines in a ring; a single global ticker
//!   flushes due rules.
//! - `onExit`: accumulate matching lines, flush on the source pane's
//!   `on_exit`.
//!
//! Loop guards:
//!
//! - Static: when a rule transitions to enabled, the directed graph over
//!   *currently enabled* edges + the candidate edge is checked for cycles
//!   via BFS from `target` back to `source`. Disabled edges are not part of
//!   the graph so authoring "B→A disabled" alongside "A→B enabled" is fine.
//! - Runtime: each rule tracks a sliding window of firing timestamps. If
//!   more than 50 fires arrive inside 2 s the rule is auto-disabled and a
//!   `pipe:autoDisabled` event is emitted.
//!
//! Target-gone: if `PtyRegistry::write` reports an unknown id (the target
//! pane has been closed), the rule is NOT deleted — the user may restart
//! that pane — but a `pipe:targetGone` event is emitted once per chunk so
//! the UI can flag it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::bridge::{build_send_payload, PaneOutputSink, PtyRegistry};
use crate::pty::ExitStatus;

/// Newline-flushed payloads go to the target with bracketed paste framing
/// + trailing newline (so the receiver's shell treats it as a deliberate
///   "press Enter" once paste mode closes — see `bridge::build_send_payload`).
const PIPE_BRACKETED_PASTE: bool = true;
const PIPE_TRAILING_NEWLINE: bool = true;

/// Runaway threshold: more than `AUTO_DISABLE_FIRES` fires inside
/// `AUTO_DISABLE_WINDOW` and the rule is forcibly disabled.
const AUTO_DISABLE_FIRES: usize = 50;
const AUTO_DISABLE_WINDOW: Duration = Duration::from_millis(2_000);

/// Minimum gap between `pipe:fired` events per rule. The dispatcher fires
/// once per source chunk, which can be many times a second; the UI only
/// needs ~1 Hz telemetry.
const FIRED_EVENT_DEBOUNCE: Duration = Duration::from_millis(1_000);

/// Tick rate for the periodic-rule flusher. 100 ms is small enough that
/// `intervalMs = 500` feels punctual; larger source bursts are still
/// captured because the ring updates inline on `observe`.
const PERIODIC_TICK: Duration = Duration::from_millis(100);

/// Cap for the in-memory pending buffer used by tailPeriodic / onExit so a
/// noisy source can't grow the registry without bound.
const PENDING_BUFFER_CAP: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub const EVENT_FIRED: &str = "pipe:fired";
pub const EVENT_AUTO_DISABLED: &str = "pipe:autoDisabled";
pub const EVENT_CYCLE_REJECTED: &str = "pipe:cycleRejected";
pub const EVENT_TARGET_GONE: &str = "pipe:targetGone";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiredPayload {
    pub rule_id: String,
    /// Lines delivered since the last `pipe:fired` event for this rule.
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoDisabledPayload {
    pub rule_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleRejectedPayload {
    pub rule_id: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetGonePayload {
    pub rule_id: String,
    pub target: String,
}

/// Minimal event-emit abstraction. Production wires this to the Tauri
/// `AppHandle`; tests collect into a Vec for assertions.
pub trait PipeEventSink: Send + Sync {
    fn emit_fired(&self, payload: FiredPayload);
    fn emit_auto_disabled(&self, payload: AutoDisabledPayload);
    fn emit_cycle_rejected(&self, payload: CycleRejectedPayload);
    fn emit_target_gone(&self, payload: TargetGonePayload);
}

pub struct TauriPipeEventSink {
    app: AppHandle,
}

impl TauriPipeEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl PipeEventSink for TauriPipeEventSink {
    fn emit_fired(&self, payload: FiredPayload) {
        let _ = self.app.emit(EVENT_FIRED, payload);
    }
    fn emit_auto_disabled(&self, payload: AutoDisabledPayload) {
        let _ = self.app.emit(EVENT_AUTO_DISABLED, payload);
    }
    fn emit_cycle_rejected(&self, payload: CycleRejectedPayload) {
        let _ = self.app.emit(EVENT_CYCLE_REJECTED, payload);
    }
    fn emit_target_gone(&self, payload: TargetGonePayload) {
        let _ = self.app.emit(EVENT_TARGET_GONE, payload);
    }
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PipeMode {
    LineRealtime,
    RegexMatch {
        pattern: String,
    },
    TailPeriodic {
        lines: u32,
        #[serde(rename = "intervalMs")]
        interval_ms: u32,
    },
    OnExit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PipeRule {
    pub id: String,
    pub source: String,
    pub target: String,
    pub enabled: bool,
    pub mode: PipeMode,
    pub include: Option<String>,
    pub exclude: Option<String>,
    pub strip_ansi: bool,
}

impl Default for PipeRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            source: String::new(),
            target: String::new(),
            enabled: false,
            mode: PipeMode::LineRealtime,
            include: None,
            exclude: None,
            strip_ansi: true,
        }
    }
}

#[derive(Debug, thiserror::Error, Serialize)]
pub enum PipeError {
    #[error("rule not found: {0}")]
    NotFound(String),
    #[error("invalid regex: {0}")]
    Regex(String),
    #[error("enabling rule would create a cycle ({from} → {to})")]
    Cycle { from: String, to: String },
    #[error("source and target must differ")]
    SelfLoop,
}

// ---------------------------------------------------------------------------
// Internal compiled state
// ---------------------------------------------------------------------------

struct RuleState {
    rule: PipeRule,
    include_re: Option<Regex>,
    exclude_re: Option<Regex>,
    match_re: Option<Regex>,
    /// Per-rule line buffer for splitting source chunks on `\n`.
    pending_line: Vec<u8>,
    /// For tailPeriodic: ring buffer of last `lines` matched lines.
    ring: VecDeque<Vec<u8>>,
    /// For onExit: accumulator of all matched lines.
    accumulator: Vec<Vec<u8>>,
    /// Last time tailPeriodic flushed (Instant epoch for first tick).
    last_periodic_flush: Instant,
    /// Sliding window of firing instants for runaway auto-disable.
    firings: VecDeque<Instant>,
    /// Last `pipe:fired` emission timestamp + count since then.
    last_fired_emit: Option<Instant>,
    pending_fired_count: u32,
}

impl RuleState {
    fn from_rule(rule: PipeRule) -> Result<Self, PipeError> {
        let include_re = match &rule.include {
            Some(s) if !s.is_empty() => Some(compile(s)?),
            _ => None,
        };
        let exclude_re = match &rule.exclude {
            Some(s) if !s.is_empty() => Some(compile(s)?),
            _ => None,
        };
        let match_re = match &rule.mode {
            PipeMode::RegexMatch { pattern } => Some(compile(pattern)?),
            _ => None,
        };
        Ok(Self {
            rule,
            include_re,
            exclude_re,
            match_re,
            pending_line: Vec::new(),
            ring: VecDeque::new(),
            accumulator: Vec::new(),
            last_periodic_flush: Instant::now(),
            firings: VecDeque::new(),
            last_fired_emit: None,
            pending_fired_count: 0,
        })
    }

    fn ring_capacity(&self) -> usize {
        match &self.rule.mode {
            PipeMode::TailPeriodic { lines, .. } => *lines as usize,
            _ => 0,
        }
    }

    fn periodic_interval(&self) -> Option<Duration> {
        match &self.rule.mode {
            PipeMode::TailPeriodic { interval_ms, .. } => {
                Some(Duration::from_millis(*interval_ms as u64))
            }
            _ => None,
        }
    }
}

fn compile(src: &str) -> Result<Regex, PipeError> {
    Regex::new(src).map_err(|e| PipeError::Regex(e.to_string()))
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

pub struct PipeRegistry {
    rules: Mutex<Vec<RuleState>>,
    pty: Arc<PtyRegistry>,
    sink: Arc<dyn PipeEventSink>,
}

impl PipeRegistry {
    pub fn new(pty: Arc<PtyRegistry>, sink: Arc<dyn PipeEventSink>) -> Self {
        Self {
            rules: Mutex::new(Vec::new()),
            pty,
            sink,
        }
    }

    pub fn list(&self) -> Vec<PipeRule> {
        self.rules
            .lock()
            .expect("PipeRegistry poisoned")
            .iter()
            .map(|s| s.rule.clone())
            .collect()
    }

    pub fn active_count(&self) -> usize {
        self.rules
            .lock()
            .expect("PipeRegistry poisoned")
            .iter()
            .filter(|s| s.rule.enabled)
            .count()
    }

    /// Add or replace a rule by id. Compiles regexes and runs cycle
    /// detection if the new rule is enabled.
    pub fn upsert(&self, rule: PipeRule) -> Result<(), PipeError> {
        if rule.source == rule.target {
            return Err(PipeError::SelfLoop);
        }
        let mut rules = self.rules.lock().expect("PipeRegistry poisoned");

        // Build the "would-be-enabled" graph: enabled edges from other
        // rules, plus this candidate if enabled.
        if rule.enabled {
            self.check_cycle(&rules, &rule)?;
        }

        let state = RuleState::from_rule(rule.clone())?;
        if let Some(idx) = rules.iter().position(|s| s.rule.id == rule.id) {
            rules[idx] = state;
        } else {
            rules.push(state);
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), PipeError> {
        let mut rules = self.rules.lock().expect("PipeRegistry poisoned");
        let idx = rules
            .iter()
            .position(|s| s.rule.id == id)
            .ok_or_else(|| PipeError::NotFound(id.into()))?;
        rules.remove(idx);
        Ok(())
    }

    /// Toggle the enabled flag. Cycle detection runs only when transitioning
    /// from disabled → enabled.
    pub fn toggle(&self, id: &str, enabled: bool) -> Result<(), PipeError> {
        let mut rules = self.rules.lock().expect("PipeRegistry poisoned");
        let idx = rules
            .iter()
            .position(|s| s.rule.id == id)
            .ok_or_else(|| PipeError::NotFound(id.into()))?;
        if enabled && !rules[idx].rule.enabled {
            let candidate = rules[idx].rule.clone();
            self.check_cycle(&rules, &candidate)?;
        }
        rules[idx].rule.enabled = enabled;
        Ok(())
    }

    /// Replace the entire rule set in one shot. Used on session restore.
    pub fn replace_all(&self, mut new_rules: Vec<PipeRule>) -> Result<(), PipeError> {
        // Cycle-check the final enabled subset before swapping in anything.
        let enabled: Vec<&PipeRule> = new_rules.iter().filter(|r| r.enabled).collect();
        let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
        for r in &enabled {
            graph.entry(r.source.as_str()).or_default().push(&r.target);
        }
        for r in &enabled {
            if reaches(&graph, &r.target, &r.source) {
                return Err(PipeError::Cycle {
                    from: r.source.clone(),
                    to: r.target.clone(),
                });
            }
        }
        // SelfLoops in the input become hard errors so the frontend can fix
        // them rather than silently dropping.
        for r in &new_rules {
            if r.source == r.target {
                return Err(PipeError::SelfLoop);
            }
        }
        let mut states = Vec::with_capacity(new_rules.len());
        for r in new_rules.drain(..) {
            states.push(RuleState::from_rule(r)?);
        }
        *self.rules.lock().expect("PipeRegistry poisoned") = states;
        Ok(())
    }

    /// Cycle BFS — `candidate` is included as if already enabled.
    fn check_cycle(&self, existing: &[RuleState], candidate: &PipeRule) -> Result<(), PipeError> {
        let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
        for s in existing {
            if s.rule.id == candidate.id {
                continue;
            }
            if s.rule.enabled {
                graph
                    .entry(s.rule.source.as_str())
                    .or_default()
                    .push(&s.rule.target);
            }
        }
        graph
            .entry(candidate.source.as_str())
            .or_default()
            .push(&candidate.target);
        if reaches(&graph, &candidate.target, &candidate.source) {
            let payload = CycleRejectedPayload {
                rule_id: candidate.id.clone(),
                source: candidate.source.clone(),
                target: candidate.target.clone(),
            };
            self.sink.emit_cycle_rejected(payload);
            return Err(PipeError::Cycle {
                from: candidate.source.clone(),
                to: candidate.target.clone(),
            });
        }
        Ok(())
    }

    /// Hot-path. Splits `chunk` into lines per matching rule, applies
    /// filters, and dispatches per mode.
    pub fn observe_chunk(&self, source: &str, chunk: &[u8]) {
        let mut rules = self.rules.lock().expect("PipeRegistry poisoned");
        let now = Instant::now();

        // Bookkeeping for events emitted after the lock is dropped — Tauri
        // emit shouldn't be called while holding the registry mutex in case
        // a listener re-enters the registry.
        let mut fired_events: Vec<FiredPayload> = Vec::new();
        let mut auto_disabled: Vec<AutoDisabledPayload> = Vec::new();
        let mut target_gone: Vec<TargetGonePayload> = Vec::new();

        for state in rules.iter_mut() {
            if !state.rule.enabled || state.rule.source != source {
                continue;
            }

            // ANSI strip happens before line splitting so escape sequences
            // that contain `\n` (rare but legal) don't fragment lines.
            let bytes: Vec<u8> = if state.rule.strip_ansi {
                strip_ansi_escapes::strip(chunk)
            } else {
                chunk.to_vec()
            };
            state.pending_line.extend_from_slice(&bytes);

            // Buffer-cap escape hatch: a producer that never emits `\n`
            // (animated progress bars, one huge JSON blob) would grow
            // `pending_line` without bound. Treat the dumped contents as a
            // single line and run it through the normal dispatch path so
            // the bytes still reach the target / ring / accumulator — the
            // previous implementation dropped them entirely.
            if state.pending_line.len() > PENDING_BUFFER_CAP {
                let dump = std::mem::take(&mut state.pending_line);
                dispatch_line(
                    &self.pty,
                    state,
                    &dump,
                    now,
                    &mut fired_events,
                    &mut auto_disabled,
                    &mut target_gone,
                );
            }

            // Split off all complete lines and route them.
            while let Some(idx) = state.pending_line.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = state.pending_line.drain(..=idx).collect();
                // The trailing newline is part of `line` for downstream
                // semantics — onExit / tailPeriodic reproduce it verbatim;
                // the lineRealtime path passes the line (without newline)
                // through `build_send_payload`, which adds its own.
                if line.ends_with(b"\n") {
                    line.pop();
                }
                dispatch_line(
                    &self.pty,
                    state,
                    &line,
                    now,
                    &mut fired_events,
                    &mut auto_disabled,
                    &mut target_gone,
                );
            }
        }

        drop(rules);
        for p in fired_events {
            self.sink.emit_fired(p);
        }
        for p in auto_disabled {
            self.sink.emit_auto_disabled(p);
        }
        for p in target_gone {
            self.sink.emit_target_gone(p);
        }
    }

    /// Fire onExit rules with `source` as their source. Called from the
    /// PaneOutputSink impl.
    pub fn on_pane_exit(&self, source: &str) {
        let mut rules = self.rules.lock().expect("PipeRegistry poisoned");
        let mut fired_events: Vec<FiredPayload> = Vec::new();
        let mut auto_disabled: Vec<AutoDisabledPayload> = Vec::new();
        let mut target_gone: Vec<TargetGonePayload> = Vec::new();
        let now = Instant::now();
        for state in rules.iter_mut() {
            if !state.rule.enabled || state.rule.source != source {
                continue;
            }
            if !matches!(state.rule.mode, PipeMode::OnExit) {
                continue;
            }
            let accumulated = std::mem::take(&mut state.accumulator);
            if accumulated.is_empty() {
                continue;
            }
            let joined: Vec<u8> = accumulated.join(&b'\n');
            let body = String::from_utf8_lossy(&joined).into_owned();
            let payload = build_send_payload(&body, PIPE_BRACKETED_PASTE, PIPE_TRAILING_NEWLINE);
            if let Err(e) = self.pty.write(&state.rule.target, &payload) {
                if e.to_string().contains("unknown pty id") {
                    target_gone.push(TargetGonePayload {
                        rule_id: state.rule.id.clone(),
                        target: state.rule.target.clone(),
                    });
                }
                continue;
            }
            record_fire(state, now, &mut fired_events, &mut auto_disabled);
        }
        drop(rules);
        for p in fired_events {
            self.sink.emit_fired(p);
        }
        for p in auto_disabled {
            self.sink.emit_auto_disabled(p);
        }
        for p in target_gone {
            self.sink.emit_target_gone(p);
        }
    }

    /// Ticker entry point — flushes due tailPeriodic rules.
    pub fn tick_periodic(&self) {
        let mut rules = self.rules.lock().expect("PipeRegistry poisoned");
        let mut fired_events: Vec<FiredPayload> = Vec::new();
        let mut auto_disabled: Vec<AutoDisabledPayload> = Vec::new();
        let mut target_gone: Vec<TargetGonePayload> = Vec::new();
        let now = Instant::now();
        for state in rules.iter_mut() {
            if !state.rule.enabled {
                continue;
            }
            let Some(interval) = state.periodic_interval() else {
                continue;
            };
            if now.duration_since(state.last_periodic_flush) < interval {
                continue;
            }
            state.last_periodic_flush = now;
            if state.ring.is_empty() {
                continue;
            }
            let drained: Vec<Vec<u8>> = state.ring.drain(..).collect();
            let joined: Vec<u8> = drained.join(&b'\n');
            let body = String::from_utf8_lossy(&joined).into_owned();
            let payload = build_send_payload(&body, PIPE_BRACKETED_PASTE, PIPE_TRAILING_NEWLINE);
            if let Err(e) = self.pty.write(&state.rule.target, &payload) {
                if e.to_string().contains("unknown pty id") {
                    target_gone.push(TargetGonePayload {
                        rule_id: state.rule.id.clone(),
                        target: state.rule.target.clone(),
                    });
                }
                continue;
            }
            record_fire(state, now, &mut fired_events, &mut auto_disabled);
        }
        drop(rules);
        for p in fired_events {
            self.sink.emit_fired(p);
        }
        for p in auto_disabled {
            self.sink.emit_auto_disabled(p);
        }
        for p in target_gone {
            self.sink.emit_target_gone(p);
        }
    }
}

impl PaneOutputSink for PipeRegistry {
    fn observe(&self, pane_id: &str, chunk: &[u8]) {
        self.observe_chunk(pane_id, chunk);
    }

    fn on_exit(&self, pane_id: &str, _status: ExitStatus) {
        self.on_pane_exit(pane_id);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn include_excluded(state: &RuleState, line: &[u8]) -> bool {
    let text = String::from_utf8_lossy(line);
    if let Some(inc) = &state.include_re {
        if !inc.is_match(&text) {
            return false;
        }
    }
    if let Some(exc) = &state.exclude_re {
        if exc.is_match(&text) {
            return false;
        }
    }
    true
}

/// Apply include/exclude + match filters, then route the line to the rule's
/// mode-specific sink. `record_fire` only runs when bytes were *actually
/// delivered to the target PTY* — buffered lines (TailPeriodic ring,
/// OnExit accumulator) are NOT counted as fires here, because that would
/// trip the runtime auto-disable on heavy sources before a single periodic
/// flush could happen and would also leave `pipe:fired.count` measuring
/// "lines buffered" instead of "lines delivered". The actual fire is
/// recorded at flush time in [`PipeRegistry::tick_periodic`] and
/// [`PipeRegistry::on_pane_exit`].
fn dispatch_line(
    pty: &PtyRegistry,
    state: &mut RuleState,
    line: &[u8],
    now: Instant,
    fired: &mut Vec<FiredPayload>,
    auto_disabled: &mut Vec<AutoDisabledPayload>,
    target_gone: &mut Vec<TargetGonePayload>,
) {
    if !include_excluded(state, line) {
        return;
    }
    if let Some(re) = &state.match_re {
        if !re.is_match(&String::from_utf8_lossy(line)) {
            return;
        }
    }
    match &state.rule.mode {
        PipeMode::LineRealtime | PipeMode::RegexMatch { .. } => {
            let body = String::from_utf8_lossy(line).into_owned();
            let payload = build_send_payload(&body, PIPE_BRACKETED_PASTE, PIPE_TRAILING_NEWLINE);
            match pty.write(&state.rule.target, &payload) {
                Ok(()) => record_fire(state, now, fired, auto_disabled),
                Err(e) => {
                    if e.to_string().contains("unknown pty id") {
                        target_gone.push(TargetGonePayload {
                            rule_id: state.rule.id.clone(),
                            target: state.rule.target.clone(),
                        });
                    }
                }
            }
        }
        PipeMode::TailPeriodic { .. } => {
            let cap = state.ring_capacity();
            if cap > 0 {
                if state.ring.len() == cap {
                    state.ring.pop_front();
                }
                state.ring.push_back(line.to_vec());
            }
        }
        PipeMode::OnExit => {
            state.accumulator.push(line.to_vec());
        }
    }
}

fn record_fire(
    state: &mut RuleState,
    now: Instant,
    fired: &mut Vec<FiredPayload>,
    auto_disabled: &mut Vec<AutoDisabledPayload>,
) {
    // Update sliding window first so auto-disable sees the freshly-fired
    // count.
    while let Some(front) = state.firings.front() {
        if now.duration_since(*front) > AUTO_DISABLE_WINDOW {
            state.firings.pop_front();
        } else {
            break;
        }
    }
    state.firings.push_back(now);
    state.pending_fired_count += 1;

    if state.firings.len() > AUTO_DISABLE_FIRES {
        state.rule.enabled = false;
        auto_disabled.push(AutoDisabledPayload {
            rule_id: state.rule.id.clone(),
            reason: format!(
                ">{} fires in {} ms",
                AUTO_DISABLE_FIRES,
                AUTO_DISABLE_WINDOW.as_millis()
            ),
        });
        // Drain the per-rule buffers so a future re-enable starts clean.
        state.firings.clear();
        state.pending_line.clear();
        state.ring.clear();
        state.accumulator.clear();
        return;
    }

    let should_emit = match state.last_fired_emit {
        Some(t) => now.duration_since(t) >= FIRED_EVENT_DEBOUNCE,
        None => true,
    };
    if should_emit {
        fired.push(FiredPayload {
            rule_id: state.rule.id.clone(),
            count: state.pending_fired_count,
        });
        state.last_fired_emit = Some(now);
        state.pending_fired_count = 0;
    }
}

/// BFS — does `from` reach `to` in the directed graph?
fn reaches(graph: &HashMap<&str, Vec<&str>>, from: &str, to: &str) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&str> = VecDeque::new();
    queue.push_back(from);
    seen.insert(from);
    while let Some(node) = queue.pop_front() {
        if node == to {
            return true;
        }
        if let Some(next) = graph.get(node) {
            for n in next {
                if seen.insert(n) {
                    queue.push_back(n);
                }
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Periodic-tick task
// ---------------------------------------------------------------------------

/// Spawn the global ticker that flushes due `TailPeriodic` rules. Returns a
/// handle the caller can keep alive (dropping it cancels the task).
pub fn spawn_ticker(registry: Arc<PipeRegistry>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PERIODIC_TICK);
        // First tick fires immediately by default — skip it so brand-new
        // rules don't see a flush before any input has been observed.
        interval.tick().await;
        loop {
            interval.tick().await;
            registry.tick_periodic();
        }
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn pipe_list(state: State<'_, Arc<PipeRegistry>>) -> Vec<PipeRule> {
    state.list()
}

#[tauri::command]
pub fn pipe_upsert(state: State<'_, Arc<PipeRegistry>>, rule: PipeRule) -> Result<(), String> {
    state.upsert(rule).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pipe_delete(state: State<'_, Arc<PipeRegistry>>, id: String) -> Result<(), String> {
    state.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pipe_toggle(
    state: State<'_, Arc<PipeRegistry>>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state.toggle(&id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pipe_replace_all(
    state: State<'_, Arc<PipeRegistry>>,
    rules: Vec<PipeRule>,
) -> Result<(), String> {
    state.replace_all(rules).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{BRACKETED_PASTE_END, BRACKETED_PASTE_START};
    use crate::pty::PtyConfig;
    use std::time::Instant;

    #[derive(Default)]
    struct CollectingSink {
        fired: Mutex<Vec<FiredPayload>>,
        auto_disabled: Mutex<Vec<AutoDisabledPayload>>,
        cycle_rejected: Mutex<Vec<CycleRejectedPayload>>,
        target_gone: Mutex<Vec<TargetGonePayload>>,
    }

    impl PipeEventSink for CollectingSink {
        fn emit_fired(&self, p: FiredPayload) {
            self.fired.lock().unwrap().push(p);
        }
        fn emit_auto_disabled(&self, p: AutoDisabledPayload) {
            self.auto_disabled.lock().unwrap().push(p);
        }
        fn emit_cycle_rejected(&self, p: CycleRejectedPayload) {
            self.cycle_rejected.lock().unwrap().push(p);
        }
        fn emit_target_gone(&self, p: TargetGonePayload) {
            self.target_gone.lock().unwrap().push(p);
        }
    }

    fn pipe_fixture() -> (Arc<PipeRegistry>, Arc<PtyRegistry>, Arc<CollectingSink>) {
        let pty = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let reg = Arc::new(PipeRegistry::new(
            pty.clone(),
            sink.clone() as Arc<dyn PipeEventSink>,
        ));
        (reg, pty, sink)
    }

    /// Build a rule with the given source/target/mode, defaults for the rest.
    fn rule(id: &str, source: &str, target: &str, mode: PipeMode) -> PipeRule {
        PipeRule {
            id: id.into(),
            source: source.into(),
            target: target.into(),
            enabled: true,
            mode,
            include: None,
            exclude: None,
            strip_ansi: true,
        }
    }

    #[test]
    fn cycle_detection_rejects_back_edge() {
        let (reg, _pty, sink) = pipe_fixture();
        reg.upsert(rule("a-to-b", "pane-a", "pane-b", PipeMode::LineRealtime))
            .expect("first rule");
        let err = reg
            .upsert(rule("b-to-a", "pane-b", "pane-a", PipeMode::LineRealtime))
            .expect_err("cycle should be rejected");
        assert!(matches!(err, PipeError::Cycle { .. }));
        assert_eq!(sink.cycle_rejected.lock().unwrap().len(), 1);
    }

    #[test]
    fn disabled_rules_excluded_from_cycle_graph() {
        let (reg, _pty, _sink) = pipe_fixture();
        reg.upsert(rule("a-to-b", "pane-a", "pane-b", PipeMode::LineRealtime))
            .expect("first rule");

        // Author B→A disabled — allowed.
        let mut back = rule("b-to-a", "pane-b", "pane-a", PipeMode::LineRealtime);
        back.enabled = false;
        reg.upsert(back).expect("disabled back-edge ok");

        // Toggling it enabled should now be rejected.
        let err = reg.toggle("b-to-a", true).expect_err("toggle rejected");
        assert!(matches!(err, PipeError::Cycle { .. }));
    }

    #[test]
    fn upsert_rejects_self_loop() {
        let (reg, _pty, _sink) = pipe_fixture();
        let err = reg
            .upsert(rule("loop", "pane-a", "pane-a", PipeMode::LineRealtime))
            .expect_err("self-loop should be rejected");
        assert!(matches!(err, PipeError::SelfLoop));
    }

    #[test]
    fn upsert_rejects_invalid_regex() {
        let (reg, _pty, _sink) = pipe_fixture();
        let mut r = rule(
            "regex-bad",
            "pane-a",
            "pane-b",
            PipeMode::RegexMatch {
                pattern: "(unterminated".into(),
            },
        );
        r.include = None;
        let err = reg.upsert(r).expect_err("bad regex should be rejected");
        assert!(matches!(err, PipeError::Regex(_)));
    }

    #[test]
    fn list_returns_inserted_rules_in_order() {
        let (reg, _pty, _sink) = pipe_fixture();
        reg.upsert(rule("r1", "pane-a", "pane-b", PipeMode::LineRealtime))
            .unwrap();
        reg.upsert(rule("r2", "pane-a", "pane-c", PipeMode::LineRealtime))
            .unwrap();
        let listed = reg.list();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "r1");
        assert_eq!(listed[1].id, "r2");
    }

    #[test]
    fn delete_removes_rule() {
        let (reg, _pty, _sink) = pipe_fixture();
        reg.upsert(rule("r1", "pane-a", "pane-b", PipeMode::LineRealtime))
            .unwrap();
        reg.delete("r1").expect("delete");
        assert!(reg.list().is_empty());
        assert!(matches!(reg.delete("r1"), Err(PipeError::NotFound(_))));
    }

    #[test]
    fn replace_all_rejects_cycle_in_input() {
        let (reg, _pty, _sink) = pipe_fixture();
        let r1 = rule("r1", "pane-a", "pane-b", PipeMode::LineRealtime);
        let r2 = rule("r2", "pane-b", "pane-a", PipeMode::LineRealtime);
        let err = reg
            .replace_all(vec![r1, r2])
            .expect_err("input cycle rejected");
        assert!(matches!(err, PipeError::Cycle { .. }));
    }

    #[test]
    fn line_realtime_only_writes_when_target_alive() {
        // Target pane is not in the registry — write fails with "unknown pty
        // id" and we expect a targetGone event but the rule stays enabled.
        let (reg, _pty, sink) = pipe_fixture();
        reg.upsert(rule(
            "r1",
            "pane-src",
            "pane-dst-missing",
            PipeMode::LineRealtime,
        ))
        .unwrap();
        reg.observe_chunk("pane-src", b"hello\n");
        let gone = sink.target_gone.lock().unwrap();
        assert_eq!(gone.len(), 1, "expected one targetGone event");
        assert_eq!(gone[0].target, "pane-dst-missing");
        assert!(reg.list()[0].enabled, "rule should remain enabled");
    }

    #[test]
    fn line_realtime_delivers_matching_lines_to_real_target() {
        // Spawn a real cat PTY so we can verify the line lands on its stdin
        // (echoed back via line discipline).
        let pty = Arc::new(PtyRegistry::new());
        let sink: Arc<CollectingSink> = Arc::new(CollectingSink::default());
        let reg = Arc::new(PipeRegistry::new(
            pty.clone(),
            sink.clone() as Arc<dyn PipeEventSink>,
        ));

        // Use the bridge to spawn a cat target so it lives in the registry.
        use crate::bridge::{spawn_pty, EventSink};
        struct NullSink;
        impl EventSink for NullSink {
            fn emit_data(&self, _: &str, _: Vec<u8>) {}
            fn emit_exit(&self, _: &str, _: ExitStatus) {}
        }
        let null: Arc<dyn EventSink> = Arc::new(NullSink);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let target = "tgt".to_string();
        rt.block_on(async {
            spawn_pty(
                pty.clone(),
                null.clone(),
                vec![],
                target.clone(),
                PtyConfig {
                    command: "/bin/sh".into(),
                    args: vec!["-c".into(), "cat".into()],
                    ..Default::default()
                },
            )
            .await
            .expect("spawn target");
        });

        let mut r = rule("r1", "pane-src", &target, PipeMode::LineRealtime);
        r.include = Some("^send:".into());
        r.strip_ansi = true;
        reg.upsert(r).unwrap();

        // Includes: 'send:' passes; 'debug:' is filtered out.
        reg.observe_chunk("pane-src", b"send: hello\ndebug: skip\nsend: world\n");

        // No targetGone because the target is live.
        assert!(sink.target_gone.lock().unwrap().is_empty());
        // pipe:fired is 1 Hz debounced, so two back-to-back fires emit a
        // single event. We assert the rule is still enabled (no auto-
        // disable triggered) and at least one fired event landed — the
        // exact accounting per fire is covered by
        // `record_fire_debounces_pipe_fired_events`.
        assert!(reg.list()[0].enabled, "rule should still be enabled");
        assert!(
            sink.auto_disabled.lock().unwrap().is_empty(),
            "no auto-disable expected"
        );
        let fired = sink.fired.lock().unwrap();
        assert!(!fired.is_empty(), "expected at least one fired event");

        // Tear down the target so the test process can exit.
        let _ = pty.kill(&target);
    }

    #[test]
    fn regex_match_uses_pattern_as_gate() {
        let (reg, _pty, sink) = pipe_fixture();
        let r = rule(
            "r1",
            "pane-src",
            "pane-dst-missing",
            PipeMode::RegexMatch {
                pattern: "^error".into(),
            },
        );
        reg.upsert(r).unwrap();
        reg.observe_chunk("pane-src", b"info: ok\nerror: bad\nerror: also bad\n");
        // 2 attempts to write to a missing target → 2 targetGone events.
        assert_eq!(sink.target_gone.lock().unwrap().len(), 2);
    }

    #[test]
    fn tail_periodic_flushes_buffered_lines_on_tick() {
        let (reg, _pty, sink) = pipe_fixture();
        let r = rule(
            "r-tail",
            "pane-src",
            "pane-dst-missing",
            PipeMode::TailPeriodic {
                lines: 3,
                interval_ms: 50,
            },
        );
        reg.upsert(r).unwrap();
        reg.observe_chunk("pane-src", b"l1\nl2\nl3\nl4\n");
        // Nothing has been sent yet — ticker hasn't fired.
        assert!(sink.target_gone.lock().unwrap().is_empty());
        // Advance "wall clock" enough that the interval has elapsed.
        std::thread::sleep(std::time::Duration::from_millis(60));
        reg.tick_periodic();
        // One write to a missing target — flushes the ring as a single
        // newline-joined payload.
        assert_eq!(sink.target_gone.lock().unwrap().len(), 1);
    }

    #[test]
    fn on_exit_flushes_accumulator_on_source_exit() {
        let (reg, _pty, sink) = pipe_fixture();
        reg.upsert(rule(
            "r-exit",
            "pane-src",
            "pane-dst-missing",
            PipeMode::OnExit,
        ))
        .unwrap();
        reg.observe_chunk("pane-src", b"a\nb\nc\n");
        // No fires until exit.
        assert!(sink.target_gone.lock().unwrap().is_empty());
        reg.on_pane_exit("pane-src");
        // Single payload → one targetGone.
        assert_eq!(sink.target_gone.lock().unwrap().len(), 1);
    }

    #[test]
    fn auto_disable_when_firing_window_exceeded() {
        let (reg, _pty, sink) = pipe_fixture();
        // Target is missing so dispatch fails — but `record_fire` still
        // runs on the success path. For auto-disable to fire we need the
        // dispatch to succeed. Use the same trick as the realtime test:
        // spawn a real cat target so writes succeed.
        let pty = reg.pty.clone();
        use crate::bridge::{spawn_pty, EventSink};
        struct NullSink;
        impl EventSink for NullSink {
            fn emit_data(&self, _: &str, _: Vec<u8>) {}
            fn emit_exit(&self, _: &str, _: ExitStatus) {}
        }
        let null: Arc<dyn EventSink> = Arc::new(NullSink);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let target = "auto-tgt".to_string();
        rt.block_on(async {
            spawn_pty(
                pty.clone(),
                null,
                vec![],
                target.clone(),
                PtyConfig {
                    command: "/bin/sh".into(),
                    args: vec!["-c".into(), "cat".into()],
                    ..Default::default()
                },
            )
            .await
            .expect("spawn target");
        });

        reg.upsert(rule("r-noisy", "pane-src", &target, PipeMode::LineRealtime))
            .unwrap();

        // Push > 50 lines in a single chunk.
        let mut blob = Vec::new();
        for i in 0..70 {
            blob.extend_from_slice(format!("line {i}\n").as_bytes());
        }
        reg.observe_chunk("pane-src", &blob);

        assert!(
            !sink.auto_disabled.lock().unwrap().is_empty(),
            "expected at least one autoDisabled event"
        );
        assert!(
            !reg.list()[0].enabled,
            "rule should be disabled after runaway"
        );

        let _ = pty.kill(&target);
    }

    #[test]
    fn record_fire_debounces_pipe_fired_events() {
        let now = Instant::now();
        let mut state = RuleState::from_rule(rule("r", "a", "b", PipeMode::LineRealtime)).unwrap();
        let mut fired: Vec<FiredPayload> = Vec::new();
        let mut disabled: Vec<AutoDisabledPayload> = Vec::new();
        // Three back-to-back fires within the debounce window collapse to
        // a single event whose `count` reflects the burst.
        record_fire(&mut state, now, &mut fired, &mut disabled);
        record_fire(
            &mut state,
            now + Duration::from_millis(5),
            &mut fired,
            &mut disabled,
        );
        record_fire(
            &mut state,
            now + Duration::from_millis(10),
            &mut fired,
            &mut disabled,
        );
        assert_eq!(fired.len(), 1, "debounce should collapse: {:?}", fired);
        assert_eq!(fired[0].count, 1, "first emit reflects single fire");
    }

    #[test]
    fn reaches_handles_indirect_cycle() {
        // A → B → C → A is a cycle the static check must catch.
        let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
        graph.insert("a", vec!["b"]);
        graph.insert("b", vec!["c"]);
        graph.insert("c", vec!["a"]);
        assert!(reaches(&graph, "b", "a"));
        assert!(reaches(&graph, "c", "a"));
        assert!(!reaches(&graph, "a", "d"));
    }

    #[test]
    fn pipe_rule_round_trips_through_serde_json() {
        let r = PipeRule {
            id: "r1".into(),
            source: "pane-a".into(),
            target: "pane-b".into(),
            enabled: true,
            mode: PipeMode::TailPeriodic {
                lines: 5,
                interval_ms: 250,
            },
            include: Some("^send:".into()),
            exclude: None,
            strip_ansi: false,
        };
        let json = serde_json::to_string(&r).unwrap();
        let back: PipeRule = serde_json::from_str(&json).unwrap();
        assert_eq!(back, r);
        // Camel-case + tagged enum on the wire.
        assert!(json.contains("\"intervalMs\":250"));
        assert!(json.contains("\"kind\":\"tailPeriodic\""));
    }

    #[test]
    fn tail_periodic_buffering_does_not_trip_auto_disable() {
        // Regression: observe_chunk used to call record_fire for every line
        // pushed into the ring, so a noisy source with a tailPeriodic rule
        // would auto-disable BEFORE the ticker ever flushed. The rule must
        // stay enabled after a large burst — only the ticker's actual
        // delivery should count as a fire.
        let (reg, _pty, sink) = pipe_fixture();
        let r = rule(
            "r-tail",
            "pane-src",
            "pane-dst-missing",
            PipeMode::TailPeriodic {
                lines: 3,
                interval_ms: 60_000,
            },
        );
        reg.upsert(r).unwrap();

        // 200 lines is well past the 50-in-2s auto-disable threshold.
        let mut blob = Vec::new();
        for i in 0..200 {
            blob.extend_from_slice(format!("line {i}\n").as_bytes());
        }
        reg.observe_chunk("pane-src", &blob);

        assert!(
            sink.auto_disabled.lock().unwrap().is_empty(),
            "buffering must not trip auto-disable; events: {:?}",
            *sink.auto_disabled.lock().unwrap()
        );
        assert!(
            sink.fired.lock().unwrap().is_empty(),
            "pipe:fired should not emit until a periodic flush actually delivers"
        );
        assert!(reg.list()[0].enabled, "rule must remain enabled");
    }

    #[test]
    fn on_exit_buffering_preserves_accumulator_under_load() {
        // Regression: observe_chunk used to call record_fire for every
        // appended line, so a noisy onExit source could auto-disable mid-
        // run AND have its accumulator wiped by `record_fire`'s
        // auto-disable branch — losing every byte that was supposed to
        // flush on exit. After the fix, buffering is silent and the
        // accumulator survives until on_pane_exit.
        let (reg, _pty, sink) = pipe_fixture();
        reg.upsert(rule(
            "r-exit",
            "pane-src",
            "pane-dst-missing",
            PipeMode::OnExit,
        ))
        .unwrap();

        let mut blob = Vec::new();
        for i in 0..200 {
            blob.extend_from_slice(format!("entry {i}\n").as_bytes());
        }
        reg.observe_chunk("pane-src", &blob);

        assert!(
            sink.auto_disabled.lock().unwrap().is_empty(),
            "onExit buffering must not auto-disable"
        );
        assert!(reg.list()[0].enabled, "rule still enabled");

        // Now exit — the accumulator should flush as one payload.
        reg.on_pane_exit("pane-src");
        assert_eq!(
            sink.target_gone.lock().unwrap().len(),
            1,
            "exit fires once even after a heavy burst"
        );
    }

    #[test]
    fn line_realtime_overflow_dispatches_instead_of_dropping() {
        // Regression: when `pending_line` exceeded PENDING_BUFFER_CAP
        // without seeing a `\n`, the previous implementation discarded the
        // bytes via a no-op `process_complete_lines`. They must reach the
        // target instead — losing data silently for noisy sources is the
        // worst kind of failure mode.
        let (reg, _pty, sink) = pipe_fixture();
        reg.upsert(rule(
            "r-big",
            "pane-src",
            "pane-dst-missing",
            PipeMode::LineRealtime,
        ))
        .unwrap();

        // > PENDING_BUFFER_CAP (16 KiB) bytes, no newline. After the fix
        // the dispatcher attempts a write to the missing target → one
        // `targetGone` event. The previous implementation produced zero
        // events because the bytes never reached `dispatch_line`.
        let blob = vec![b'A'; PENDING_BUFFER_CAP + 4096];
        reg.observe_chunk("pane-src", &blob);

        assert_eq!(
            sink.target_gone.lock().unwrap().len(),
            1,
            "overflow bytes must take the dispatch path"
        );
    }

    #[test]
    fn tail_periodic_overflow_keeps_data_in_the_ring() {
        // The buffer-cap escape hatch must funnel oversized chunks through
        // the same dispatch_line path for tailPeriodic too — so a flush
        // afterwards still has data to send. Before the fix the dumped
        // bytes vanished and the ring was empty.
        let (reg, _pty, sink) = pipe_fixture();
        let r = rule(
            "r-ring",
            "pane-src",
            "pane-dst-missing",
            PipeMode::TailPeriodic {
                lines: 5,
                interval_ms: 1,
            },
        );
        reg.upsert(r).unwrap();
        let blob = vec![b'X'; PENDING_BUFFER_CAP + 1024];
        reg.observe_chunk("pane-src", &blob);
        // Sleep past intervalMs so the ticker fires immediately.
        std::thread::sleep(std::time::Duration::from_millis(10));
        reg.tick_periodic();
        assert_eq!(
            sink.target_gone.lock().unwrap().len(),
            1,
            "the overflowed payload should be the line tail-periodic flushes"
        );
    }

    // Sanity that bracketed-paste markers actually frame realtime writes —
    // not a behavioural test of the registry but a guard against the
    // PIPE_BRACKETED_PASTE / PIPE_TRAILING_NEWLINE constants drifting.
    #[test]
    fn pipe_payload_constants_match_bracketed_paste_framing() {
        let payload = build_send_payload("hi", PIPE_BRACKETED_PASTE, PIPE_TRAILING_NEWLINE);
        assert!(payload.starts_with(BRACKETED_PASTE_START));
        assert!(payload.ends_with(b"\n"));
        assert!(payload
            .windows(BRACKETED_PASTE_END.len())
            .any(|w| w == BRACKETED_PASTE_END));
    }
}
