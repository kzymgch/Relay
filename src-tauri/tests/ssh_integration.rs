//! End-to-end test: spin up an embedded russh server on `127.0.0.1:0`,
//! connect with `SshSession`, exchange bytes, and verify the channel shape
//! works the same as a local PTY (output flows to the mpsc receiver, exit
//! flows to the oneshot).
//!
//! Keeps the test suite self-contained — no external `sshd` required, so
//! macOS CI runners pass without the user accepting Keychain prompts.

use std::sync::Arc;
use std::time::Duration;

use relay_lib::ssh::{SshAuth, SshConnectConfig, SshSession};
use russh::keys::ssh_key;
use russh::server::{Auth, Msg, Server, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

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
