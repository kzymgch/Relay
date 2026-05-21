//! PTY wrapper around `portable-pty`.
//!
//! Owns the master end of a pseudo-terminal, spawns the child process, and
//! exposes:
//!
//! - `write_all` — send bytes to the child's stdin
//! - `resize` — resize the PTY (cols, rows)
//! - `kill` — terminate the child
//! - `recv` / `try_recv` — read chunks from the child's stdout/stderr
//! - `wait` / `try_wait` — observe the exit status
//!
//! Output flow uses a bounded `tokio::sync::mpsc` channel as backpressure
//! foundation: when the consumer falls behind, the reader thread blocks on
//! `blocking_send`, which propagates back into the OS PTY buffer and
//! eventually pauses the child's writes.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("pty io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("pty error: {0}")]
    Pty(String),
    #[error("child already exited or never started")]
    AlreadyExited,
}

impl From<anyhow::Error> for PtyError {
    fn from(value: anyhow::Error) -> Self {
        Self::Pty(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, PtyError>;

#[derive(Debug, Clone)]
pub struct PtyConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    /// Maximum number of output chunks buffered before the reader blocks.
    /// Acts as the backpressure foundation; consumers must drain `recv`.
    pub output_buffer_chunks: usize,
}

impl Default for PtyConfig {
    fn default() -> Self {
        Self {
            command: String::new(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
            output_buffer_chunks: 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitStatus {
    pub code: u32,
    pub success: bool,
}

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    output_rx: Option<mpsc::Receiver<Vec<u8>>>,
    exit_rx: Option<oneshot::Receiver<ExitStatus>>,
    cached_exit: Option<ExitStatus>,
}

impl Pty {
    pub fn spawn(config: PtyConfig) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: config.rows,
            cols: config.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&config.command);
        cmd.args(&config.args);
        if let Some(cwd) = &config.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd)?;
        let killer = child.clone_killer();
        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        // Drop the slave handle on this side so the reader sees EOF after the
        // child's own slave fd is closed at exit.
        drop(pair.slave);

        let capacity = config.output_buffer_chunks.max(1);
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(capacity);
        let (exit_tx, exit_rx) = oneshot::channel::<ExitStatus>();

        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });

        thread::spawn(move || {
            let status = match child.wait() {
                Ok(s) => ExitStatus {
                    code: s.exit_code(),
                    success: s.success(),
                },
                Err(_) => ExitStatus {
                    code: u32::MAX,
                    success: false,
                },
            };
            let _ = exit_tx.send(status);
        });

        Ok(Pty {
            master: pair.master,
            writer,
            killer,
            output_rx: Some(output_rx),
            exit_rx: Some(exit_rx),
            cached_exit: None,
        })
    }

    /// Move the output receiver out of the `Pty`. After this call, `recv` /
    /// `try_recv` will return `None`. Used by the Tauri bridge to forward
    /// chunks to the frontend from a dedicated task.
    pub fn take_output_rx(&mut self) -> Option<mpsc::Receiver<Vec<u8>>> {
        self.output_rx.take()
    }

    /// Move the exit receiver out of the `Pty`. After this call, `wait` /
    /// `try_wait` will return `AlreadyExited` / `None`.
    pub fn take_exit_rx(&mut self) -> Option<oneshot::Receiver<ExitStatus>> {
        self.exit_rx.take()
    }

    pub fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&mut self) -> Result<()> {
        self.killer.kill()?;
        Ok(())
    }

    /// Wait for the next output chunk. Returns `None` after EOF or if the
    /// receiver has been taken via [`take_output_rx`].
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        self.output_rx.as_mut()?.recv().await
    }

    /// Non-blocking output peek. Returns `None` if no chunk is ready, the
    /// stream is closed, or the receiver has been taken.
    pub fn try_recv(&mut self) -> Option<Vec<u8>> {
        self.output_rx.as_mut()?.try_recv().ok()
    }

    pub async fn wait(&mut self) -> Result<ExitStatus> {
        if let Some(s) = self.cached_exit {
            return Ok(s);
        }
        let rx = self.exit_rx.take().ok_or(PtyError::AlreadyExited)?;
        let status = rx.await.map_err(|_| PtyError::AlreadyExited)?;
        self.cached_exit = Some(status);
        Ok(status)
    }

    pub fn try_wait(&mut self) -> Option<ExitStatus> {
        if let Some(s) = self.cached_exit {
            return Some(s);
        }
        let rx = self.exit_rx.as_mut()?;
        match rx.try_recv() {
            Ok(status) => {
                self.cached_exit = Some(status);
                Some(status)
            }
            Err(_) => None,
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        // Best-effort cleanup. Errors are expected if the child has already
        // exited.
        let _ = self.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    fn echo_config(message: &str) -> PtyConfig {
        PtyConfig {
            command: "/bin/echo".into(),
            args: vec![message.into()],
            ..Default::default()
        }
    }

    async fn drain_until_exit(pty: &mut Pty) -> Vec<u8> {
        let mut buf = Vec::new();
        // Cap the drain so a runaway test can't hang the suite.
        let drain = timeout(Duration::from_secs(5), async {
            while let Some(chunk) = pty.recv().await {
                buf.extend_from_slice(&chunk);
            }
        });
        drain.await.expect("drain timed out");
        buf
    }

    #[tokio::test(flavor = "current_thread")]
    async fn captures_echo_output() {
        let mut pty = Pty::spawn(echo_config("hello-relay")).expect("spawn");
        let output = drain_until_exit(&mut pty).await;
        let text = String::from_utf8_lossy(&output);
        assert!(
            text.contains("hello-relay"),
            "expected echo output, got {text:?}"
        );
        let status = pty.wait().await.expect("wait");
        assert!(status.success, "echo should exit 0, got {status:?}");
        assert_eq!(status.code, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn detects_nonzero_exit_code() {
        let mut pty = Pty::spawn(PtyConfig {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 7".into()],
            ..Default::default()
        })
        .expect("spawn");
        let status = pty.wait().await.expect("wait");
        assert_eq!(status.code, 7, "exit 7 expected, got {status:?}");
        assert!(!status.success);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delivers_stdin_to_child() {
        // `sh -c "read line; printf 'got=%s\n' \"$line\""` proves the byte
        // path: write_all -> master -> slave -> child stdin -> child stdout
        // -> master -> recv. If take_writer / flush were broken, "got=abc"
        // would never appear because read would block forever.
        let mut pty = Pty::spawn(PtyConfig {
            command: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "read line; printf 'got=%s\\n' \"$line\"".into(),
            ],
            ..Default::default()
        })
        .expect("spawn");
        pty.write_all(b"abc\n").expect("write_all");
        let output = drain_until_exit(&mut pty).await;
        let text = String::from_utf8_lossy(&output);
        assert!(
            text.contains("got=abc"),
            "child did not see stdin payload, got {text:?}"
        );
        let status = pty.wait().await.expect("wait");
        assert!(status.success, "shell exited non-zero: {status:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn applies_initial_size_to_pty() {
        // `stty size` prints "<rows> <cols>" as observed by the slave.
        // This catches a cols/rows swap in PtySize construction.
        let mut pty = Pty::spawn(PtyConfig {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "stty size".into()],
            cols: 120,
            rows: 40,
            ..Default::default()
        })
        .expect("spawn");
        let output = drain_until_exit(&mut pty).await;
        let text = String::from_utf8_lossy(&output);
        let has_size = text.lines().any(|l| l.trim() == "40 120");
        assert!(has_size, "expected '40 120' from stty size, got {text:?}");
        let status = pty.wait().await.expect("wait");
        assert!(status.success);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resize_updates_pty_size() {
        // The child prints stty size twice with a delay in between. We resize
        // during the delay and expect the second reading to reflect the new
        // dimensions.
        let mut pty = Pty::spawn(PtyConfig {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "stty size; sleep 0.5; stty size".into()],
            cols: 80,
            rows: 24,
            ..Default::default()
        })
        .expect("spawn");

        // Drain until the first reading lands so the resize is unambiguously
        // applied between the two stty invocations.
        let mut buf = Vec::new();
        let waited = timeout(Duration::from_secs(3), async {
            while let Some(chunk) = pty.recv().await {
                buf.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf)
                    .lines()
                    .any(|l| l.trim() == "24 80")
                {
                    return;
                }
            }
        })
        .await;
        assert!(
            waited.is_ok(),
            "did not observe initial '24 80', got {:?}",
            String::from_utf8_lossy(&buf)
        );

        pty.resize(120, 40).expect("resize");

        let drain = timeout(Duration::from_secs(5), async {
            while let Some(chunk) = pty.recv().await {
                buf.extend_from_slice(&chunk);
            }
        });
        drain.await.expect("drain timed out");

        let text = String::from_utf8_lossy(&buf);
        let has_resized = text.lines().any(|l| l.trim() == "40 120");
        assert!(
            has_resized,
            "expected '40 120' after resize, full output: {text:?}"
        );
        let status = pty.wait().await.expect("wait");
        assert!(status.success);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn kill_terminates_long_running_child() {
        let mut pty = Pty::spawn(PtyConfig {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 60".into()],
            ..Default::default()
        })
        .expect("spawn");
        pty.kill().expect("kill");
        let status = timeout(Duration::from_secs(5), pty.wait())
            .await
            .expect("wait timeout")
            .expect("wait");
        // Killed child does not exit successfully.
        assert!(
            !status.success,
            "killed child should not be success: {status:?}"
        );
    }
}
