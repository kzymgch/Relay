//! End-to-end test: spin up an embedded russh server on `127.0.0.1:0`,
//! connect with `SshSession`, exchange bytes, and verify the channel shape
//! works the same as a local PTY (output flows to the mpsc receiver, exit
//! flows to the oneshot).
//!
//! Keeps the test suite self-contained — no external `sshd` required, so
//! macOS CI runners pass without the user accepting Keychain prompts.

use std::sync::Arc;
use std::time::Duration;

use std::sync::Mutex;

use relay_lib::bridge::{spawn_ssh, EventSink, PtyRegistry, SshState, SshStatus};
use relay_lib::pty::ExitStatus;
use relay_lib::ssh::{SshAuth, SshConnectConfig, SshSession};
use russh::keys::ssh_key;
use russh::server::{Auth, Msg, Server, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

/// Simple in-memory event sink used to assert on the bridge's lifecycle
/// events without standing up a Tauri runtime.
#[derive(Default)]
struct CapturingSink {
    data: Mutex<Vec<(String, Vec<u8>)>>,
    exits: Mutex<Vec<(String, ExitStatus)>>,
    statuses: Mutex<Vec<(String, SshStatus, u32)>>,
}

impl CapturingSink {
    fn exit_count(&self, id: &str) -> usize {
        self.exits
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _)| p == id)
            .count()
    }
    fn last_exit(&self, id: &str) -> Option<ExitStatus> {
        self.exits
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(p, _)| p == id)
            .map(|(_, s)| *s)
    }
    fn ssh_statuses(&self, id: &str) -> Vec<(SshStatus, u32)> {
        self.statuses
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(p, s, a)| if p == id { Some((*s, *a)) } else { None })
            .collect()
    }
}

impl EventSink for CapturingSink {
    fn emit_data(&self, pane_id: &str, data: Vec<u8>) {
        self.data.lock().unwrap().push((pane_id.into(), data));
    }
    fn emit_exit(&self, pane_id: &str, status: ExitStatus) {
        self.exits.lock().unwrap().push((pane_id.into(), status));
    }
    fn emit_ssh_status(&self, pane_id: &str, status: SshStatus, attempt: u32) {
        self.statuses
            .lock()
            .unwrap()
            .push((pane_id.into(), status, attempt));
    }
}

struct TestServer;

impl Server for TestServer {
    type Handler = TestHandler;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self::Handler {
        TestHandler
    }
    fn handle_session_error(&mut self, error: <Self::Handler as russh::server::Handler>::Error) {
        eprintln!("test server session error: {error:#?}");
    }
}

struct TestHandler;

impl russh::server::Handler for TestHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn auth_publickey_offered(
        &mut self,
        _user: &str,
        _key: &ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        _channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // A fake "ready" banner so the client sees output even before sending
        // anything — mirrors a real shell's prompt.
        session.data(channel, bytes::Bytes::from_static(b"READY\n"))?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Echo with a prefix so the test can distinguish the server response
        // from its own write.
        let mut response = b"echo:".to_vec();
        response.extend_from_slice(data);
        session.data(channel, bytes::Bytes::from(response))?;
        Ok(())
    }
}

async fn start_test_server() -> u16 {
    let socket = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = socket.local_addr().expect("local_addr").port();

    let host_key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .expect("host key");
    let config = russh::server::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        auth_rejection_time: Duration::from_millis(0),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        keys: vec![host_key],
        ..Default::default()
    };
    let config = Arc::new(config);

    let mut server = TestServer;
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &socket).await;
    });
    port
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_roundtrip_against_embedded_server() {
    let port = start_test_server().await;
    // Give the listener a moment to start accepting before we connect.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut session = SshSession::connect(SshConnectConfig {
        host: "127.0.0.1".into(),
        port,
        user: "testuser".into(),
        auth: SshAuth::Password("hunter2".into()),
        cols: 80,
        rows: 24,
        term: "xterm-256color".into(),
        output_buffer_chunks: 32,
        connect_timeout: Duration::from_secs(5),
    })
    .await
    .expect("ssh connect");

    let mut output_rx = session.take_output_rx().expect("output rx");
    let _exit_rx = session.take_exit_rx().expect("exit rx");

    // Send a payload and wait for the prefixed echo response. We loop because
    // the server emits its READY banner before our write; we just want to
    // observe our echo round-tripping.
    session.write_all(b"ping\n").expect("write");

    let mut buf = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), output_rx.recv()).await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.windows(b"echo:ping".len()).any(|w| w == b"echo:ping") {
                    // Clean shutdown so the test exits promptly.
                    session.kill().expect("kill");
                    return;
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
    panic!(
        "expected to observe 'echo:ping' in output; got {:?}",
        String::from_utf8_lossy(&buf)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn user_initiated_kill_reports_clean_exit() {
    // The bridge's SSH supervisor uses `ExitStatus::success` to distinguish
    // user-initiated teardown (clean: do not reconnect) from a network drop
    // (dirty: enter the backoff loop). If this property regresses, closing
    // an SSH pane would trigger a futile reconnect attempt.
    let port = start_test_server().await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut session = SshSession::connect(SshConnectConfig {
        host: "127.0.0.1".into(),
        port,
        user: "testuser".into(),
        auth: SshAuth::Password("any".into()),
        cols: 80,
        rows: 24,
        term: "xterm-256color".into(),
        output_buffer_chunks: 32,
        connect_timeout: Duration::from_secs(5),
    })
    .await
    .expect("ssh connect");

    let _output_rx = session.take_output_rx().expect("output rx");
    let exit_rx = session.take_exit_rx().expect("exit rx");

    session.kill().expect("kill");

    let status = tokio::time::timeout(Duration::from_secs(5), exit_rx)
        .await
        .expect("exit timeout")
        .expect("exit rx closed");
    assert!(
        status.success,
        "user-initiated kill should produce a success-coded exit (got {status:?})"
    );
    assert_eq!(
        status.code, 0,
        "user kill should report code 0, not the disconnect sentinel"
    );
}

/// User closing an SSH pane while it is live must result in exactly one
/// `pty:exit` event (success-coded), no reconnect attempts, and clean
/// teardown of the supervisor task. Regression coverage for the bug where
/// `pty_kill` raced the backoff sleep and produced spurious "reconnecting"
/// status emits before the pane disappeared.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn supervisor_treats_user_kill_as_clean_shutdown() {
    use std::sync::Arc;

    let port = start_test_server().await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let registry = Arc::new(PtyRegistry::new());
    let sink: Arc<CapturingSink> = Arc::new(CapturingSink::default());
    let ssh_state = Arc::new(SshState::new());

    let id = "pane-kill".to_string();
    spawn_ssh(
        registry.clone(),
        sink.clone(),
        Vec::new(),
        ssh_state.clone(),
        id.clone(),
        SshConnectConfig {
            host: "127.0.0.1".into(),
            port,
            user: "kill-tester".into(),
            auth: SshAuth::Password("any".into()),
            cols: 80,
            rows: 24,
            term: "xterm-256color".into(),
            output_buffer_chunks: 32,
            connect_timeout: Duration::from_secs(5),
        },
        true,
    )
    .await
    .expect("spawn_ssh");

    // Wait for the `Connected` status — that's our signal the supervisor
    // is past initial connect and parked in `drain_until_exit`.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let connected = sink
            .ssh_statuses(&id)
            .iter()
            .any(|(s, _)| *s == SshStatus::Connected);
        if connected {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "never observed Connected status; got {:?}",
            sink.ssh_statuses(&id)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Simulate `pty_kill` for an SSH pane: signal shutdown, then kill via
    // the registry. The kill path sends `SshCommand::Kill` to the pump,
    // which reports `success: true`; the supervisor sees that AND the
    // shutdown flag, both routes terminate without reconnect.
    ssh_state.signal_shutdown(&id);
    registry.kill(&id).expect("kill");

    // Wait for the supervisor to finalize and emit pty:exit.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if sink.exit_count(&id) > 0 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "supervisor never emitted pty:exit after kill"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Give the supervisor a moment in case it spuriously tries to reconnect
    // — any subsequent Reconnecting / Connecting status emit is a bug.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let exit = sink.last_exit(&id).expect("exit observed");
    assert!(
        exit.success,
        "user kill should produce success-coded exit, got {exit:?}"
    );
    assert_eq!(
        sink.exit_count(&id),
        1,
        "exactly one pty:exit expected; got {} events: {:?}",
        sink.exit_count(&id),
        sink.exits.lock().unwrap()
    );
    let statuses = sink.ssh_statuses(&id);
    assert!(
        !statuses
            .iter()
            .any(|(s, _)| matches!(s, SshStatus::Reconnecting | SshStatus::Disconnected)),
        "user kill must not trigger Disconnected / Reconnecting; saw {statuses:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_session_resize_does_not_error() {
    // Resize requests go through the same command channel as writes; this
    // smoke-tests that the pump translates them to a `window_change` without
    // panicking and that the server happily accepts the channel request.
    let port = start_test_server().await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut session = SshSession::connect(SshConnectConfig {
        host: "127.0.0.1".into(),
        port,
        user: "testuser".into(),
        auth: SshAuth::Password("any".into()),
        cols: 80,
        rows: 24,
        term: "xterm-256color".into(),
        output_buffer_chunks: 32,
        connect_timeout: Duration::from_secs(5),
    })
    .await
    .expect("ssh connect");

    let _output_rx = session.take_output_rx().expect("output rx");
    let _exit_rx = session.take_exit_rx().expect("exit rx");

    session.resize(120, 40).expect("resize");
    // No way to assert the server saw the resize through the public API,
    // but we want to ensure the call doesn't return an error.
    tokio::time::sleep(Duration::from_millis(50)).await;
    session.kill().expect("kill");
}
