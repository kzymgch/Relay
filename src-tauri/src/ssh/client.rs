//! `russh` wrapper that exposes the same channel shape as `Pty`.
//!
//! From the bridge's perspective an `SshSession` is a black box that produces
//! output chunks on an `mpsc::Receiver<Vec<u8>>` and signals exit on a
//! `oneshot::Receiver<ExitStatus>`. Writes / resizes / kills are queued on a
//! command channel that a dedicated tokio task drains, calling the
//! corresponding russh `Channel` methods.
//!
//! That single-task design avoids deadlocks: russh's channel methods are
//! `async fn` and require ownership; trying to call them inline from a
//! synchronous `write` would either need a runtime block (illegal inside
//! tokio's current_thread runtime) or `&mut` on the session everywhere.
//!
//! Server-key checking is currently TOFU-style (accept any). The plan flags
//! known_hosts as out of scope for v1 — revisit before any real deployment.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Handler};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use crate::pty::ExitStatus;

#[derive(Debug, Error)]
pub enum SshError {
    #[error("ssh io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("ssh protocol error: {0}")]
    Protocol(String),
    #[error("ssh authentication failed")]
    AuthFailed,
    #[error("ssh session closed")]
    Closed,
}

impl From<russh::Error> for SshError {
    fn from(value: russh::Error) -> Self {
        Self::Protocol(value.to_string())
    }
}

impl From<russh::keys::Error> for SshError {
    fn from(value: russh::keys::Error) -> Self {
        Self::Protocol(format!("key load: {value}"))
    }
}

#[derive(Debug, Clone)]
pub enum SshAuth {
    /// Password-only authentication.
    Password(String),
    /// Public-key authentication. `passphrase` decrypts the on-disk key.
    Key {
        path: PathBuf,
        passphrase: Option<String>,
    },
    /// Try public-key first; fall back to password if the key load fails or
    /// the server refuses the key. Useful when a host accepts either.
    KeyOrPassword {
        path: PathBuf,
        passphrase: Option<String>,
        password: String,
    },
}

#[derive(Debug, Clone)]
pub struct SshConnectConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    pub cols: u16,
    pub rows: u16,
    pub term: String,
    pub output_buffer_chunks: usize,
    pub connect_timeout: Duration,
}

impl Default for SshConnectConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 22,
            user: String::new(),
            auth: SshAuth::Password(String::new()),
            cols: 80,
            rows: 24,
            term: "xterm-256color".into(),
            output_buffer_chunks: 1024,
            connect_timeout: Duration::from_secs(15),
        }
    }
}

/// Per-pane russh session. After `connect`, the caller takes the output and
/// exit receivers; the remaining `write_all` / `resize` / `kill` calls queue
/// commands for the internal task.
pub struct SshSession {
    cmd_tx: Option<mpsc::Sender<SshCommand>>,
    output_rx: Option<mpsc::Receiver<Vec<u8>>>,
    exit_rx: Option<oneshot::Receiver<ExitStatus>>,
    cached_exit: Option<ExitStatus>,
}

enum SshCommand {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Kill,
}

/// Trivial Handler — we accept any server key for v1 (no known_hosts).
struct AcceptAnyServer;

impl Handler for AcceptAnyServer {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

impl SshSession {
    pub async fn connect(config: SshConnectConfig) -> Result<Self, SshError> {
        let SshConnectConfig {
            host,
            port,
            user,
            auth,
            cols,
            rows,
            term,
            output_buffer_chunks,
            connect_timeout,
        } = config;

        let cfg = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            ..Default::default()
        });
        let connect_fut = client::connect(cfg, (host.as_str(), port), AcceptAnyServer);
        let mut session = tokio::time::timeout(connect_timeout, connect_fut)
            .await
            .map_err(|_| {
                SshError::Protocol(format!("connect timed out after {connect_timeout:?}"))
            })??;

        authenticate(&mut session, &user, &auth).await?;

        let channel = session.channel_open_session().await?;
        channel
            .request_pty(false, &term, u32::from(cols), u32::from(rows), 0, 0, &[])
            .await?;
        channel.request_shell(false).await?;

        let capacity = output_buffer_chunks.max(1);
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(capacity);
        let (exit_tx, exit_rx) = oneshot::channel::<ExitStatus>();
        // Command buffer sized for human-typing bursts; SSH writes are slow
        // enough that 256 queued ops covers any realistic UI cadence.
        let (cmd_tx, cmd_rx) = mpsc::channel::<SshCommand>(256);

        let session_handle = session;
        tokio::spawn(async move {
            pump(session_handle, channel, output_tx, exit_tx, cmd_rx).await;
        });

        Ok(Self {
            cmd_tx: Some(cmd_tx),
            output_rx: Some(output_rx),
            exit_rx: Some(exit_rx),
            cached_exit: None,
        })
    }

    pub fn take_output_rx(&mut self) -> Option<mpsc::Receiver<Vec<u8>>> {
        self.output_rx.take()
    }

    pub fn take_exit_rx(&mut self) -> Option<oneshot::Receiver<ExitStatus>> {
        self.exit_rx.take()
    }

    pub fn write_all(&self, bytes: &[u8]) -> Result<(), SshError> {
        self.send_cmd(SshCommand::Write(bytes.to_vec()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), SshError> {
        self.send_cmd(SshCommand::Resize { cols, rows })
    }

    pub fn kill(&self) -> Result<(), SshError> {
        self.send_cmd(SshCommand::Kill)
    }

    fn send_cmd(&self, cmd: SshCommand) -> Result<(), SshError> {
        let tx = self.cmd_tx.as_ref().ok_or(SshError::Closed)?;
        // try_send: the alternative (blocking_send) would freeze the calling
        // thread if the runtime is current_thread + the pump task is also on
        // it. A full queue means the remote is back-pressuring us; surfacing
        // the error lets the caller log + drop the input.
        tx.try_send(cmd).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => {
                SshError::Protocol("ssh write buffer full".into())
            }
            mpsc::error::TrySendError::Closed(_) => SshError::Closed,
        })
    }

    pub async fn wait(&mut self) -> Result<ExitStatus, SshError> {
        if let Some(s) = self.cached_exit {
            return Ok(s);
        }
        let rx = self.exit_rx.take().ok_or(SshError::Closed)?;
        let status = rx.await.map_err(|_| SshError::Closed)?;
        self.cached_exit = Some(status);
        Ok(status)
    }
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // Trigger best-effort shutdown so the pump task disconnects the
        // server even if no one explicitly called `kill`.
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.try_send(SshCommand::Kill);
        }
    }
}

async fn try_password(
    session: &mut Handle<AcceptAnyServer>,
    user: &str,
    password: &str,
) -> Result<(), SshError> {
    let res = session
        .authenticate_password(user.to_string(), password.to_string())
        .await?;
    if !res.success() {
        return Err(SshError::AuthFailed);
    }
    Ok(())
}

async fn try_key(
    session: &mut Handle<AcceptAnyServer>,
    user: &str,
    path: &PathBuf,
    passphrase: Option<&str>,
) -> Result<(), SshError> {
    let key = load_secret_key(path, passphrase)?;
    let hash = session.best_supported_rsa_hash().await?.flatten();
    let res = session
        .authenticate_publickey(
            user.to_string(),
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await?;
    if !res.success() {
        return Err(SshError::AuthFailed);
    }
    Ok(())
}

async fn authenticate(
    session: &mut Handle<AcceptAnyServer>,
    user: &str,
    auth: &SshAuth,
) -> Result<(), SshError> {
    match auth {
        SshAuth::Password(password) => try_password(session, user, password).await,
        SshAuth::Key { path, passphrase } => {
            try_key(session, user, path, passphrase.as_deref()).await
        }
        SshAuth::KeyOrPassword {
            path,
            passphrase,
            password,
        } => {
            // Fall through to password whenever the key path fails — keeps
            // working when the file is missing or the server refuses the key.
            match try_key(session, user, path, passphrase.as_deref()).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!("relay-ssh: key auth failed ({e}); falling back to password");
                    try_password(session, user, password).await
                }
            }
        }
    }
}

async fn pump(
    session: Handle<AcceptAnyServer>,
    mut channel: russh::Channel<russh::client::Msg>,
    output_tx: mpsc::Sender<Vec<u8>>,
    exit_tx: oneshot::Sender<ExitStatus>,
    mut cmd_rx: mpsc::Receiver<SshCommand>,
) {
    let mut pending_exit_code: Option<u32> = None;
    let mut user_killed = false;
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        // mpsc full means the consumer dropped — give up.
                        if output_tx.send(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        // SSH stderr (ext type 1). xterm consumes both
                        // streams indistinguishably so we just forward.
                        if output_tx.send(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        pending_exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                        break;
                    }
                    Some(_) => {}
                    None => {
                        break;
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SshCommand::Write(bytes)) => {
                        if let Err(e) = channel.data(&bytes[..]).await {
                            eprintln!("relay-ssh: channel.data failed: {e}");
                            break;
                        }
                    }
                    Some(SshCommand::Resize { cols, rows }) => {
                        if let Err(e) = channel
                            .window_change(u32::from(cols), u32::from(rows), 0, 0)
                            .await
                        {
                            eprintln!("relay-ssh: window_change failed: {e}");
                        }
                    }
                    // Explicit Kill = user-initiated teardown (close button,
                    // restart, app exit). Reported back as `success: true`
                    // so the bridge supervisor treats this as a clean
                    // shutdown and doesn't enter the reconnect loop. `None`
                    // (sender dropped) also means the SshSession was dropped
                    // by its owner — same intent.
                    Some(SshCommand::Kill) | None => {
                        user_killed = true;
                        break;
                    }
                }
            }
        }
    }

    // Best-effort cleanup. Any error here is expected if the peer is already
    // gone or the channel has been closed for other reasons.
    let _ = channel.close().await;
    let _ = session
        .disconnect(Disconnect::ByApplication, "relay closing", "en-US")
        .await;

    let status = match (user_killed, pending_exit_code) {
        // User asked us to close: clean shutdown, no reconnect.
        (true, _) => ExitStatus {
            code: 0,
            success: true,
        },
        // Remote shell sent an explicit exit status: respect it (a 0 means
        // the user logged out cleanly; non-zero means the shell died but
        // didn't disconnect, which still counts as a final exit).
        (false, Some(code)) => ExitStatus {
            code,
            success: code == 0,
        },
        // No exit status, no kill — network drop. Surface as non-success
        // so the bridge triggers reconnect on the SSH-pane code path.
        (false, None) => ExitStatus {
            code: u32::MAX,
            success: false,
        },
    };
    let _ = exit_tx.send(status);
}
