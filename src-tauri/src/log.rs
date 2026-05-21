//! Per-pane file logging (spec §11).
//!
//! Subscribes to PTY output via [`crate::bridge::PaneOutputSink`] and writes
//! each pane's bytes to a file under the configured directory.
//!
//! Two modes:
//!
//! - `raw` — bytes verbatim, ANSI sequences included. Use for forensic
//!   replay or piping back into another terminal.
//! - `plain` — ANSI-stripped, then per-line secret-regex masked. Use for
//!   shareable logs.
//!
//! Rotation kicks in when the current file passes `max_bytes` OR (if
//! `daily_rotation` is on) when the local date changes. The previous file
//! is renamed `<basename>.YYYYMMDD-N` where `N` is the lowest free integer;
//! older backups are pruned to `max_files`.
//!
//! Per-line buffering note: `plain` mode masks each *complete* line, so
//! chunks that arrive mid-line are buffered until a `\n` lands. A
//! pathological producer that never emits `\n` (e.g. an animated progress
//! bar) would grow the buffer unbounded — we cap it at 1 MiB and flush
//! as-is past that.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use chrono::{Local, NaiveDate};
use regex::Regex;
use serde::Serialize;
use tauri::State;

use crate::bridge::PaneOutputSink;
use crate::config::LoggingConfig;
use crate::pty::ExitStatus;

const PLAIN_LINE_BUFFER_CAP: usize = 1024 * 1024;
const MASK_REPLACEMENT: &str = "***";

#[derive(Debug, thiserror::Error, Serialize)]
pub enum LogError {
    #[error("io: {0}")]
    Io(String),
    #[error("regex: {0}")]
    Regex(String),
}

impl From<std::io::Error> for LogError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<regex::Error> for LogError {
    fn from(e: regex::Error) -> Self {
        Self::Regex(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogMode {
    Raw,
    Plain,
}

impl LogMode {
    fn parse(s: &str) -> Self {
        match s {
            "raw" => Self::Raw,
            _ => Self::Plain,
        }
    }
}

#[derive(Debug)]
pub struct CompiledLogConfig {
    pub enabled: bool,
    pub dir: PathBuf,
    pub mode: LogMode,
    pub max_bytes: u64,
    pub max_files: u32,
    pub daily_rotation: bool,
    pub secrets: Vec<Regex>,
}

impl CompiledLogConfig {
    pub fn compile(raw: &LoggingConfig, default_dir: PathBuf) -> Result<Self, LogError> {
        let dir = if raw.dir.trim().is_empty() {
            default_dir
        } else {
            PathBuf::from(&raw.dir)
        };
        let mut secrets = Vec::with_capacity(raw.secrets.len());
        for src in &raw.secrets {
            secrets.push(Regex::new(src)?);
        }
        Ok(Self {
            enabled: raw.enabled,
            dir,
            mode: LogMode::parse(&raw.mode),
            max_bytes: raw.max_bytes,
            max_files: raw.max_files,
            daily_rotation: raw.daily_rotation,
            secrets,
        })
    }

    pub fn disabled(dir: PathBuf) -> Self {
        Self {
            enabled: false,
            dir,
            mode: LogMode::Plain,
            max_bytes: 0,
            max_files: 0,
            daily_rotation: false,
            secrets: Vec::new(),
        }
    }
}

struct LogFile {
    path: PathBuf,
    writer: BufWriter<File>,
    written_bytes: u64,
    opened_on: NaiveDate,
    pending_line: Vec<u8>,
}

impl LogFile {
    fn open(dir: &Path, pane_id: &str, today: NaiveDate) -> Result<Self, LogError> {
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("{pane_id}.log"));
        let file = OpenOptions::new().append(true).create(true).open(&path)?;
        let written_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            path,
            writer: BufWriter::new(file),
            written_bytes,
            opened_on: today,
            pending_line: Vec::new(),
        })
    }
}

/// Pane → log-file map plus the swappable compiled config. The config is
/// stored behind `ArcSwap` so the config-watcher thread can swap a new
/// compiled snapshot in without blocking the PTY forward task.
pub struct LogRegistry {
    config: ArcSwap<CompiledLogConfig>,
    files: Mutex<HashMap<String, LogFile>>,
}

impl LogRegistry {
    pub fn new(initial: CompiledLogConfig) -> Self {
        Self {
            config: ArcSwap::from_pointee(initial),
            files: Mutex::new(HashMap::new()),
        }
    }

    pub fn swap_config(&self, next: CompiledLogConfig) {
        // Close every open file. The next `observe` reopens against the new
        // directory / mode — simpler than reasoning about in-flight writes
        // that straddle a config change.
        let mut files = self.files.lock().expect("LogRegistry poisoned");
        for (_, mut f) in files.drain() {
            let _ = f.writer.flush();
        }
        drop(files);
        self.config.store(Arc::new(next));
    }

    pub fn current_dir(&self) -> PathBuf {
        self.config.load().dir.clone()
    }

    /// Path the current writer is targeting (or would target) for `pane_id`.
    pub fn pane_log_path(&self, pane_id: &str) -> PathBuf {
        self.config.load().dir.join(format!("{pane_id}.log"))
    }

    /// Read up to `max_bytes` from the tail of the current pane log. Returns
    /// an empty Vec if the file doesn't exist yet.
    pub fn tail(&self, pane_id: &str, max_bytes: u64) -> Result<Vec<u8>, LogError> {
        let path = self.pane_log_path(pane_id);
        let mut file = match File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let len = file.metadata()?.len();
        let take = max_bytes.min(len);
        let start = len.saturating_sub(take);
        file.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::with_capacity(take as usize);
        file.take(take).read_to_end(&mut buf)?;
        Ok(buf)
    }

    /// Test/wiring entry point — same as `observe` but propagates the error
    /// instead of swallowing it (the trait impl can't return errors).
    pub fn write_chunk(&self, pane_id: &str, chunk: &[u8]) -> Result<(), LogError> {
        let cfg = self.config.load_full();
        if !cfg.enabled {
            return Ok(());
        }
        let today = Local::now().date_naive();
        let mut files = self.files.lock().expect("LogRegistry poisoned");
        let entry = match files.get_mut(pane_id) {
            Some(e) => e,
            None => {
                let lf = LogFile::open(&cfg.dir, pane_id, today)?;
                files.entry(pane_id.to_string()).or_insert(lf)
            }
        };

        // Date rotation up-front so a mid-day config swap or a long-running
        // pane doesn't bleed across day boundaries.
        if cfg.daily_rotation && entry.opened_on != today {
            rotate(entry, &cfg, today)?;
        }

        match cfg.mode {
            LogMode::Raw => {
                entry.writer.write_all(chunk)?;
                entry.written_bytes += chunk.len() as u64;
            }
            LogMode::Plain => {
                write_plain(entry, chunk, &cfg.secrets)?;
            }
        }

        if cfg.max_bytes > 0 && entry.written_bytes >= cfg.max_bytes {
            rotate(entry, &cfg, today)?;
        }
        entry.writer.flush()?;
        Ok(())
    }

    /// Flush + close the per-pane handle. Called from `on_exit`.
    pub fn drop_pane(&self, pane_id: &str) {
        let mut files = self.files.lock().expect("LogRegistry poisoned");
        if let Some(mut f) = files.remove(pane_id) {
            // Plain-mode tail without trailing \n still gets written so the
            // last line isn't silently lost on exit.
            if !f.pending_line.is_empty() {
                let cfg = self.config.load_full();
                let stripped = strip_ansi_escapes::strip(&f.pending_line);
                let masked = mask_secrets(&stripped, &cfg.secrets);
                let _ = f.writer.write_all(&masked);
                f.pending_line.clear();
            }
            let _ = f.writer.flush();
        }
    }
}

impl PaneOutputSink for LogRegistry {
    fn observe(&self, pane_id: &str, chunk: &[u8]) {
        // Errors swallowed deliberately — logging must never break the PTY
        // forward path. Failures land in stderr for the operator to see.
        if let Err(e) = self.write_chunk(pane_id, chunk) {
            eprintln!("relay log: write failed for {pane_id}: {e}");
        }
    }

    fn on_exit(&self, pane_id: &str, _status: ExitStatus) {
        self.drop_pane(pane_id);
    }
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

fn rotate(entry: &mut LogFile, cfg: &CompiledLogConfig, today: NaiveDate) -> Result<(), LogError> {
    entry.writer.flush()?;
    let dir = entry
        .path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = entry
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("log")
        .to_string();
    let date_str = entry.opened_on.format("%Y%m%d").to_string();

    // Pick the smallest free index.
    let mut n: u32 = 1;
    let rotated = loop {
        let candidate = dir.join(format!("{stem}.{date_str}-{n}"));
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
        if n > 100_000 {
            // Defensive cap — shouldn't ever hit, but avoids unbounded loop
            // if the filesystem is doing something weird.
            return Err(LogError::Io("rotation index exhausted".into()));
        }
    };

    fs::rename(&entry.path, &rotated)?;
    prune_backups(&dir, &stem, cfg.max_files)?;

    // Reopen fresh.
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&entry.path)?;
    entry.writer = BufWriter::new(file);
    entry.written_bytes = 0;
    entry.opened_on = today;
    entry.pending_line.clear();
    Ok(())
}

fn prune_backups(dir: &Path, stem: &str, max_files: u32) -> Result<(), LogError> {
    if max_files == 0 {
        return Ok(());
    }
    let prefix = format!("{stem}.");
    let mut backups: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(n) = name.to_str() else { continue };
        if !n.starts_with(&prefix) || n == stem {
            continue;
        }
        let modified = entry
            .metadata()?
            .modified()
            .unwrap_or(std::time::UNIX_EPOCH);
        backups.push((entry.path(), modified));
    }
    if backups.len() as u32 <= max_files {
        return Ok(());
    }
    // Newest first — oldest get pruned.
    backups.sort_by_key(|b| std::cmp::Reverse(b.1));
    for (path, _) in backups.iter().skip(max_files as usize) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Plain-mode helpers
// ---------------------------------------------------------------------------

fn write_plain(entry: &mut LogFile, chunk: &[u8], secrets: &[Regex]) -> Result<(), LogError> {
    entry.pending_line.extend_from_slice(chunk);

    // Pathological producers (animated progress bars rewriting one line)
    // could grow pending_line unbounded. Flush as-is past the cap; we lose
    // the mask but keep memory bounded.
    if entry.pending_line.len() > PLAIN_LINE_BUFFER_CAP {
        let stripped = strip_ansi_escapes::strip(&entry.pending_line);
        entry.writer.write_all(&stripped)?;
        entry.written_bytes += stripped.len() as u64;
        entry.pending_line.clear();
        return Ok(());
    }

    while let Some(idx) = entry.pending_line.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = entry.pending_line.drain(..=idx).collect();
        let stripped = strip_ansi_escapes::strip(&line);
        let masked = mask_secrets(&stripped, secrets);
        entry.writer.write_all(&masked)?;
        entry.written_bytes += masked.len() as u64;
    }
    Ok(())
}

fn mask_secrets(line: &[u8], secrets: &[Regex]) -> Vec<u8> {
    if secrets.is_empty() {
        return line.to_vec();
    }
    // Secrets are configured as regex sources; we operate on a String view
    // and tolerate non-UTF8 by falling back to lossy decode + re-encode.
    let mut text = String::from_utf8_lossy(line).into_owned();
    for re in secrets {
        text = re.replace_all(&text, MASK_REPLACEMENT).into_owned();
    }
    text.into_bytes()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn log_tail(
    state: State<'_, Arc<LogRegistry>>,
    pane_id: String,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    state.tail(&pane_id, max_bytes).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture(dir: &TempDir, mode: LogMode) -> LogRegistry {
        LogRegistry::new(CompiledLogConfig {
            enabled: true,
            dir: dir.path().to_path_buf(),
            mode,
            max_bytes: 0,
            max_files: 5,
            daily_rotation: false,
            secrets: Vec::new(),
        })
    }

    fn read_log(dir: &TempDir, pane_id: &str) -> String {
        let path = dir.path().join(format!("{pane_id}.log"));
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn raw_mode_writes_bytes_verbatim_including_ansi() {
        let dir = tempfile::tempdir().unwrap();
        let log = fixture(&dir, LogMode::Raw);
        log.write_chunk("pane-r", b"\x1b[31merror\x1b[0m\n")
            .unwrap();
        log.drop_pane("pane-r");
        let body = read_log(&dir, "pane-r");
        assert!(body.contains("\x1b[31m"), "raw must keep ANSI: {body:?}");
        assert!(body.contains("error"));
    }

    #[test]
    fn plain_mode_strips_ansi_and_writes_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let log = fixture(&dir, LogMode::Plain);
        log.write_chunk("pane-p", b"\x1b[31merror\x1b[0m\n")
            .unwrap();
        log.drop_pane("pane-p");
        let body = read_log(&dir, "pane-p");
        assert_eq!(body, "error\n");
    }

    #[test]
    fn plain_mode_buffers_partial_line_across_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let log = fixture(&dir, LogMode::Plain);
        log.write_chunk("pane-buf", b"hel").unwrap();
        log.write_chunk("pane-buf", b"lo\n").unwrap();
        log.drop_pane("pane-buf");
        assert_eq!(read_log(&dir, "pane-buf"), "hello\n");
    }

    #[test]
    fn plain_mode_flushes_trailing_partial_line_on_drop() {
        // Process that exits without a trailing newline: the dangling
        // bytes still reach the file (just unmasked of newline).
        let dir = tempfile::tempdir().unwrap();
        let log = fixture(&dir, LogMode::Plain);
        log.write_chunk("pane-x", b"oops without newline").unwrap();
        log.drop_pane("pane-x");
        let body = read_log(&dir, "pane-x");
        assert!(
            body.contains("oops without newline"),
            "drop_pane should flush dangling buffer, got {body:?}"
        );
    }

    #[test]
    fn secret_regex_masks_lines_in_plain_mode() {
        let dir = tempfile::tempdir().unwrap();
        let log = LogRegistry::new(CompiledLogConfig {
            enabled: true,
            dir: dir.path().to_path_buf(),
            mode: LogMode::Plain,
            max_bytes: 0,
            max_files: 5,
            daily_rotation: false,
            secrets: vec![Regex::new("sk-[A-Za-z0-9]+").unwrap()],
        });
        log.write_chunk("pane-s", b"key sk-abcdef ok\n").unwrap();
        log.drop_pane("pane-s");
        let body = read_log(&dir, "pane-s");
        assert_eq!(body, "key *** ok\n");
    }

    #[test]
    fn size_rotation_creates_dated_backup_and_resets_file() {
        let dir = tempfile::tempdir().unwrap();
        let log = LogRegistry::new(CompiledLogConfig {
            enabled: true,
            dir: dir.path().to_path_buf(),
            mode: LogMode::Raw,
            max_bytes: 16,
            max_files: 5,
            daily_rotation: false,
            secrets: Vec::new(),
        });
        // Each line is 8 bytes — 3 of them push us past the 16-byte cap and
        // trigger a rotation between the 2nd and 3rd write.
        log.write_chunk("pane-rot", b"AAAAAAA\n").unwrap();
        log.write_chunk("pane-rot", b"BBBBBBB\n").unwrap();
        log.write_chunk("pane-rot", b"CCCCCCC\n").unwrap();
        log.drop_pane("pane-rot");

        // Current file holds the tail after the rotation point.
        let live = read_log(&dir, "pane-rot");
        assert!(
            live.contains("CCCCCCC"),
            "current file should hold post-rotation tail: {live:?}"
        );

        // Exactly one rotated file exists, suffixed `<date>-1`.
        let date = Local::now().date_naive().format("%Y%m%d").to_string();
        let mut rotated: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| {
                let p = e.ok()?.path();
                let name = p.file_name()?.to_str()?.to_string();
                if name.contains(&date) && name != "pane-rot.log" {
                    Some(p)
                } else {
                    None
                }
            })
            .collect();
        rotated.sort();
        assert_eq!(rotated.len(), 1, "expected one rotated backup: {rotated:?}");
        let backup = std::fs::read_to_string(&rotated[0]).unwrap();
        assert!(backup.contains("AAAAAAA"));
        assert!(backup.contains("BBBBBBB"));
    }

    #[test]
    fn rotation_prunes_oldest_when_over_max_files() {
        let dir = tempfile::tempdir().unwrap();
        let log = LogRegistry::new(CompiledLogConfig {
            enabled: true,
            dir: dir.path().to_path_buf(),
            mode: LogMode::Raw,
            max_bytes: 4,
            max_files: 2,
            daily_rotation: false,
            secrets: Vec::new(),
        });
        for n in 0..5 {
            // Each write exceeds the 4-byte cap so every other call rotates.
            log.write_chunk("p", format!("LINE{n}\n").as_bytes())
                .unwrap();
        }
        log.drop_pane("p");
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| {
                let p = e.ok()?.path();
                let n = p.file_name()?.to_str()?.to_string();
                if n != "p.log" {
                    Some(n)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            backups.len() <= 2,
            "max_files=2 must cap backups, got {backups:?}"
        );
    }

    #[test]
    fn tail_returns_last_max_bytes_or_full_file_when_shorter() {
        let dir = tempfile::tempdir().unwrap();
        let log = fixture(&dir, LogMode::Raw);
        log.write_chunk("p", b"0123456789").unwrap();
        log.drop_pane("p");
        let full = log.tail("p", 1000).unwrap();
        assert_eq!(full, b"0123456789");
        let last3 = log.tail("p", 3).unwrap();
        assert_eq!(last3, b"789");
    }

    #[test]
    fn tail_on_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let log = fixture(&dir, LogMode::Raw);
        assert!(log.tail("never-written", 1000).unwrap().is_empty());
    }

    #[test]
    fn disabled_config_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let log = LogRegistry::new(CompiledLogConfig::disabled(dir.path().to_path_buf()));
        log.write_chunk("p", b"hello\n").unwrap();
        log.drop_pane("p");
        assert!(!dir.path().join("p.log").exists());
    }

    #[test]
    fn swap_config_flushes_open_files() {
        let dir = tempfile::tempdir().unwrap();
        let log = fixture(&dir, LogMode::Raw);
        log.write_chunk("p", b"early\n").unwrap();
        // Swap to a new config (still enabled but in a different dir) —
        // the prior file must be closed and reflect the bytes already
        // written, even though we never explicitly dropped the pane.
        let dir2 = tempfile::tempdir().unwrap();
        log.swap_config(CompiledLogConfig {
            enabled: true,
            dir: dir2.path().to_path_buf(),
            mode: LogMode::Raw,
            max_bytes: 0,
            max_files: 5,
            daily_rotation: false,
            secrets: Vec::new(),
        });
        assert_eq!(read_log(&dir, "p"), "early\n");
        // Subsequent writes target the new dir.
        log.write_chunk("p", b"late\n").unwrap();
        log.drop_pane("p");
        assert_eq!(read_log(&dir2, "p"), "late\n");
    }
}
