//! The relay over real sockets, for what the TypeScript suite's WebSocket client can't
//! send: fragments, frames cut across writes, pings, plain HTTP, a receiver that stops
//! reading, and a stop. That suite covers the contract itself (apps/relay-rs/README.md).

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use polaris_relay::config::Config;
use polaris_relay::events::Events;
use polaris_relay::server::{Relay, listen};
use polaris_relay::wire::{self, Address, Role};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(5);

const TEXT: u8 = 0x1;
const BINARY: u8 = 0x2;
const CLOSE: u8 = 0x8;
const PING: u8 = 0x9;
const PONG: u8 = 0xA;
const FIN: u8 = 0x80;

/// The relay's wide events, as the lines it wrote.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);

impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);

        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Log {
    fn events(&self) -> Vec<Value> {
        let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();

        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    /// Waits for a connection's line that ended as `ended_by`.
    async fn ended(&self, ended_by: &str) -> Value {
        for _ in 0..500 {
            let found = self.events().into_iter().find(|event| event["endedBy"] == ended_by);

            if let Some(event) = found {
                return event;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        panic!("no connection ended by {ended_by}: {:?}", self.events());
    }
}

struct TestRelay {
    port: u16,
    log: Log,
    stop: Option<oneshot::Sender<()>>,
    served: JoinHandle<std::io::Result<()>>,
}

/// Starts a relay on a free port, on this test's own loop, with room to connect freely.
fn start(change: impl FnOnce(&mut Config)) -> TestRelay {
    let mut config =
        Config { port: 0, hostname: "127.0.0.1".into(), workers: Some(1), ..Config::default() };
    config.gate.connects_per_second_per_ip = 1_000.0;
    config.gate.connect_burst_per_ip = 1_000.0;
    config.gate.max_connections_per_ip = 1_000;
    change(&mut config);
    let log = Log::default();
    let relay = Relay::new(config, Events::to(Box::new(log.clone()))).unwrap();
    let listening = listen(relay).unwrap();
    let port = listening.port;
    let (stop, stopped) = oneshot::channel::<()>();

    let served = tokio::spawn(listening.serve(async move {
        let _ = stopped.await;
    }));

    TestRelay { port, log, stop: Some(stop), served }
}

/// A party speaking the WebSocket protocol by hand, so a test chooses every byte.
struct Client {
    stream: TcpStream,
    buf: Vec<u8>,
    key: SigningKey,
}

fn masked(first: u8, payload: &[u8]) -> Vec<u8> {
    let mask = [0x37, 0xfa, 0x21, 0x3d];
    let mut frame = vec![first];

    match payload.len() {
        len @ 0..=125 => frame.push(0x80 | len as u8),
        len @ 126..=65_535 => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        }
        len => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
    }

    frame.extend_from_slice(&mask);
    frame.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ mask[index % 4]));

    frame
}

fn forward(peer: &Address, record: &[u8]) -> Vec<u8> {
    let mut frame = vec![1, 1, 22];
    frame.extend_from_slice(peer.as_bytes());
    frame.extend_from_slice(record);

    frame
}

impl Client {
    /// Upgrades a new socket and leaves the challenge unread.
    async fn open(port: u16) -> Self {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.set_nodelay(true).unwrap();

        let request = "GET /v1 HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
        stream.write_all(request.as_bytes()).await.unwrap();
        let key = SigningKey::from_bytes(&rand::random::<[u8; 32]>());
        let mut client = Self { stream, buf: Vec::new(), key };
        let head = client.until(b"\r\n\r\n").await;
        assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
        assert!(head.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"), "{head}");

        client
    }

    /// Opens a socket and proves a new key as `role`; returns once the relay says ready.
    async fn connect(port: u16, role: Role, peers: Option<&[Address]>) -> Self {
        let mut client = Self::open(port).await;
        let challenge = client.control().await;
        let nonce = wire::from_base64url(challenge["nonce"].as_str().unwrap()).unwrap();
        let signature = client.key.sign(&wire::auth_message(&nonce, role));

        let mut auth = json!({
            "t": "auth",
            "role": role.as_str(),
            "key": wire::to_base64url(client.key.verifying_key().as_bytes()),
            "sig": wire::to_base64url(&signature.to_bytes()),
        });

        if let Some(peers) = peers {
            auth["peers"] = json!(peers);
        }

        client.send(FIN | TEXT, auth.to_string().as_bytes()).await;
        assert_eq!(client.control().await, json!({ "t": "ready", "address": client.address() }));

        client
    }

    fn address(&self) -> Address {
        Address::of_key(self.key.verifying_key().as_bytes())
    }

    async fn more(&mut self) -> usize {
        timeout(WAIT, self.stream.read_buf(&mut self.buf))
            .await
            .expect("the relay sent nothing")
            .unwrap()
    }

    /// Reads up to and including `end`, as text.
    async fn until(&mut self, end: &[u8]) -> String {
        loop {
            if let Some(at) = self.buf.windows(end.len()).position(|window| window == end) {
                let taken: Vec<u8> = self.buf.drain(..at + end.len()).collect();

                return String::from_utf8(taken).unwrap();
            }

            assert!(self.more().await > 0, "closed before {:?}", String::from_utf8_lossy(end));
        }
    }

    async fn send(&mut self, first: u8, payload: &[u8]) {
        self.stream.write_all(&masked(first, payload)).await.unwrap();
    }

    /// The next frame the relay sent: its first byte and its payload.
    async fn frame(&mut self) -> (u8, Vec<u8>) {
        loop {
            if let Some((first, head, len)) = self.head()
                && self.buf.len() >= head + len
            {
                let frame: Vec<u8> = self.buf.drain(..head + len).collect();

                return (first, frame[head..].to_vec());
            }

            assert!(self.more().await > 0, "closed before a whole frame");
        }
    }

    fn head(&self) -> Option<(u8, usize, usize)> {
        let (first, short) = (*self.buf.first()?, *self.buf.get(1)?);
        // A server never masks.
        assert_eq!(short & 0x80, 0);

        match short {
            126 => Some((
                first,
                4,
                usize::from(u16::from_be_bytes(self.buf.get(2..4)?.try_into().ok()?)),
            )),
            127 => Some((
                first,
                10,
                u64::from_be_bytes(self.buf.get(2..10)?.try_into().ok()?) as usize,
            )),
            len => Some((first, 2, usize::from(len))),
        }
    }

    /// The next frame, which must be a control message.
    async fn control(&mut self) -> Value {
        let (first, payload) = self.frame().await;
        assert_eq!(first, FIN | TEXT, "{:?}", String::from_utf8_lossy(&payload));

        serde_json::from_slice(&payload).unwrap()
    }

    /// The next frame, which must be a forwarded record: who sent it, and the record.
    async fn record(&mut self) -> (Address, Vec<u8>) {
        let (first, payload) = self.frame().await;
        assert_eq!(first, FIN | BINARY, "{:?}", String::from_utf8_lossy(&payload));

        (wire::forward_peer(&payload).unwrap(), payload[wire::HEADER_BYTES..].to_vec())
    }

    /// The close frame's code and reason; anything before it is a failure.
    async fn closed(&mut self) -> (u16, String) {
        let (first, payload) = self.frame().await;
        assert_eq!(first, FIN | CLOSE, "{:?}", String::from_utf8_lossy(&payload));

        (
            u16::from_be_bytes([payload[0], payload[1]]),
            String::from_utf8(payload[2..].to_vec()).unwrap(),
        )
    }
}

/// A host and the device it lists, both ready and past each other's presence.
async fn pair(port: u16) -> (Client, Client) {
    let mut device = Client::connect(port, Role::Device, None).await;
    let mut host = Client::connect(port, Role::Host, Some(&[device.address()])).await;

    assert_eq!(
        host.control().await,
        json!({ "t": "presence", "peer": device.address(), "online": true })
    );
    assert_eq!(
        device.control().await,
        json!({ "t": "presence", "peer": host.address(), "online": true })
    );

    (host, device)
}

#[tokio::test]
async fn a_message_sent_in_fragments_arrives_whole_and_a_ping_between_them_is_answered() {
    let relay = start(|_| {});
    let (mut host, mut device) = pair(relay.port).await;
    let record: Vec<u8> = (0..5_000u32).map(|n| n as u8).collect();
    let message = forward(&host.address(), &record);

    device.send(BINARY, &message[..10]).await;
    device.send(FIN | PING, b"between").await;
    device.send(0x0, &message[10..3_000]).await;
    device.send(FIN, &message[3_000..]).await;

    assert_eq!(device.frame().await, (FIN | PONG, b"between".to_vec()));
    assert_eq!(host.record().await, (device.address(), record));
}

#[tokio::test]
async fn frames_cut_anywhere_across_writes_and_frames_sharing_a_write_are_each_forwarded() {
    let relay = start(|config| config.messages_per_second = 10_000);
    let (mut host, mut device) = pair(relay.port).await;
    let records: Vec<Vec<u8>> =
        [1, 130, 70_000 - 5_000, 9, 400].iter().map(|len| vec![*len as u8; *len]).collect();
    let mut bytes = Vec::new();

    for record in &records {
        bytes.extend(masked(FIN | BINARY, &forward(&host.address(), record)));
    }

    // Each chunk ends inside a header, a mask or a payload, and the last carries two frames.
    for chunk in [1, 1, 3, 20, 5, 9, 100, 40, 7, 30_000, 20_000, 14_000] {
        let rest = bytes.split_off(chunk.min(bytes.len()));
        device.stream.write_all(&bytes).await.unwrap();
        device.stream.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(3)).await;
        bytes = rest;
    }

    device.stream.write_all(&bytes).await.unwrap();

    for record in records {
        assert_eq!(host.record().await, (device.address(), record));
    }
}

#[tokio::test]
async fn a_burst_many_read_turns_long_arrives_whole_and_in_order() {
    let relay = start(|_| {});
    let (mut host, mut device) = pair(relay.port).await;
    let from = device.address();

    // Nearly 3 MiB in one write, in sizes that end a turn inside a header or a payload.
    let records: Vec<Vec<u8>> =
        (0..120usize).map(|n| vec![n as u8; [60_000, 7, 33_333, 1_000][n % 4]]).collect();

    let mut bytes = Vec::new();

    for record in &records {
        bytes.extend(masked(FIN | BINARY, &forward(&host.address(), record)));
    }

    let write = async { device.stream.write_all(&bytes).await.unwrap() };

    let read = async {
        for record in &records {
            assert_eq!(host.record().await, (from, record.clone()));
        }
    };

    tokio::join!(write, read);
}

#[tokio::test]
async fn a_frame_that_breaks_the_protocol_is_closed_as_such() {
    let relay = start(|_| {});
    let mut unmasked = Client::connect(relay.port, Role::Device, None).await;
    unmasked.stream.write_all(&[FIN | BINARY, 0x01, 0x00]).await.unwrap();
    assert_eq!(unmasked.closed().await, (1002, "protocol-error".to_owned()));

    let mut stray = Client::connect(relay.port, Role::Device, None).await;
    stray.send(FIN, b"a continuation of nothing").await;
    assert_eq!(stray.closed().await, (1002, "protocol-error".to_owned()));

    let mut fragments = Client::connect(relay.port, Role::Device, None).await;
    fragments.send(BINARY, &vec![0; 40_000]).await;
    fragments.send(FIN, &vec![0; 40_000]).await;
    assert_eq!(fragments.closed().await, (1009, "too-big".to_owned()));
    assert_eq!(relay.log.ended("too-big").await["closeCode"], 1009);
}

#[tokio::test]
async fn plain_requests_are_answered_in_turn_on_one_connection() {
    let relay = start(|_| {});
    let mut stream = TcpStream::connect(("127.0.0.1", relay.port)).await.unwrap();
    let mut client = Client {
        stream: TcpStream::connect(("127.0.0.1", relay.port)).await.unwrap(),
        buf: Vec::new(),
        key: SigningKey::from_bytes(&[7; 32]),
    };

    let requests = "GET /healthz HTTP/1.1\r\nHost: relay\r\n\r\nGET /nowhere HTTP/1.1\r\nHost: relay\r\n\r\nGET /v1 HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n";
    client.stream.write_all(requests.as_bytes()).await.unwrap();
    let mut replies = String::new();
    timeout(WAIT, client.stream.read_to_string(&mut replies)).await.unwrap().unwrap();

    // A reply's body runs straight into the next reply's status line.
    let statuses: Vec<&str> =
        replies.split("HTTP/1.1 ").skip(1).filter_map(|reply| reply.lines().next()).collect();

    assert_eq!(statuses, ["200 OK", "404 Not Found", "426 Upgrade Required"]);
    assert!(replies.contains("\r\n\r\nokHTTP/1.1 404"), "{replies}");
    assert!(
        replies.ends_with("Connection: close\r\n\r\nExpected a WebSocket upgrade"),
        "{replies}"
    );

    // A request that isn't HTTP is refused and the socket closed.
    stream.write_all(b"\x16\x03\x01 not http\r\n\r\n").await.unwrap();
    let mut refusal = String::new();
    timeout(WAIT, stream.read_to_string(&mut refusal)).await.unwrap().unwrap();
    assert!(refusal.starts_with("HTTP/1.1 400 Bad Request\r\n"), "{refusal}");
}

#[tokio::test]
async fn a_connection_is_closed_after_its_share_of_plain_requests() {
    let relay = start(|_| {});
    let mut stream = TcpStream::connect(("127.0.0.1", relay.port)).await.unwrap();

    stream
        .write_all("GET /healthz HTTP/1.1\r\nHost: relay\r\n\r\n".repeat(40).as_bytes())
        .await
        .unwrap();
    let mut replies = String::new();
    // The relay closes the socket, so the read ends without the client asking.
    timeout(WAIT, stream.read_to_string(&mut replies)).await.unwrap().unwrap();

    assert_eq!(replies.matches("HTTP/1.1 200 OK").count(), 32, "{replies}");
    assert_eq!(replies.matches("Connection: close").count(), 1);
    assert!(replies.ends_with("Connection: close\r\n\r\nok"), "{replies}");
}

#[tokio::test]
async fn sockets_that_have_not_upgraded_are_bounded_and_one_that_leaves_makes_room() {
    // The floor applies: 64 sockets mid-handshake, however small the relay's limit.
    let relay = start(|config| config.gate.max_connections = 1);
    let mut waiting = Vec::new();

    for _ in 0..64 {
        let mut stream = TcpStream::connect(("127.0.0.1", relay.port)).await.unwrap();
        // Half a request head, so the relay holds the socket open for the rest.
        stream.write_all(b"GET /healthz HTTP/1.1\r\n").await.unwrap();
        waiting.push(stream);
    }

    let healthz = async || {
        let mut stream = TcpStream::connect(("127.0.0.1", relay.port)).await.unwrap();
        let request = b"GET /healthz HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n";
        let mut reply = String::new();
        // A socket the relay drops may be reset before or after the request is written.
        let _ = stream.write_all(request).await;
        let _ = timeout(WAIT, stream.read_to_string(&mut reply)).await.unwrap();

        reply
    };

    // Sockets are taken in the order they connected, so this one is the 65th.
    assert_eq!(healthz().await, "", "one more socket than the bound was answered");
    let refusals: Vec<Value> =
        relay.log.events().into_iter().filter(|event| event["event"] == "relay.refused").collect();
    assert_eq!(refusals.len(), 1, "{refusals:?}");
    assert_eq!(refusals[0]["reason"], "relay-full");

    // The waiting sockets are still served, and one leaving lets another in.
    let mut first = waiting.remove(0);
    first.write_all(b"Host: relay\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut reply = String::new();
    timeout(WAIT, first.read_to_string(&mut reply)).await.unwrap().unwrap();
    assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
    assert!(healthz().await.starts_with("HTTP/1.1 200 OK"));
}

#[tokio::test]
async fn a_receiver_that_stops_reading_is_dropped_and_its_sender_carries_on() {
    let relay = start(|config| {
        config.backpressure_limit_bytes = 256 * 1024;
        config.messages_per_second = 1_000_000;
        config.bytes_per_second = u32::MAX / 4;
    });

    let (mut host, device) = pair(relay.port).await;
    let frame = masked(FIN | BINARY, &forward(&device.address(), &vec![7; 60_000]));

    // Far more than the sockets between them hold: the relay must queue, then give up.
    for _ in 0..600 {
        host.stream.write_all(&frame).await.unwrap();
    }

    let event = relay.log.ended("backpressure").await;
    assert_eq!((&event["role"], &event["closeCode"]), (&json!("device"), &json!(1006)));

    // The host hears the device go and is still served.
    assert_eq!(
        host.control().await,
        json!({ "t": "presence", "peer": device.address(), "online": false })
    );
    host.send(FIN | BINARY, &forward(&device.address(), b"after")).await;

    loop {
        let message = host.control().await;

        if message["t"] == "unreachable" {
            break assert_eq!(message["peer"], json!(device.address()));
        }
    }
}

#[tokio::test]
async fn a_quiet_socket_is_pinged_and_kept_while_it_answers() {
    let relay = start(|config| config.idle_timeout_seconds = 1);
    let mut client = Client::connect(relay.port, Role::Device, None).await;

    for _ in 0..3 {
        assert_eq!(client.frame().await, (FIN | PING, Vec::new()));
        client.send(FIN | PONG, &[]).await;
    }

    // Past its timeout three times over, it is still served; once it stops answering, it goes.
    client.send(FIN | PING, b"alive").await;
    assert_eq!(client.frame().await, (FIN | PONG, b"alive".to_vec()));
    assert_eq!(client.frame().await, (FIN | PING, Vec::new()));
    assert_eq!(timeout(WAIT, client.stream.read_buf(&mut client.buf)).await.unwrap().unwrap(), 0);
    assert_eq!(relay.log.ended("idle").await["closeCode"], 1006);
}

#[tokio::test]
async fn stopping_closes_every_socket_and_logs_each_before_it_returns() {
    let mut relay = start(|_| {});
    let (mut host, mut device) = pair(relay.port).await;
    let mut stranger = Client::open(relay.port).await;
    stranger.control().await;

    relay.stop.take().unwrap().send(()).unwrap();

    for client in [&mut host, &mut device, &mut stranger] {
        assert_eq!(client.closed().await, (1001, "shutdown".to_owned()));
    }

    drop((host, device, stranger));
    timeout(WAIT, relay.served).await.unwrap().unwrap().unwrap();
    let ended: Vec<Value> = relay
        .log
        .events()
        .into_iter()
        .filter(|event| event["event"] == "relay.connection")
        .collect();

    assert_eq!(ended.len(), 3);
    assert!(ended.iter().all(|event| event["endedBy"] == "shutdown" && event["closeCode"] == 1001));
    assert!(TcpStream::connect(("127.0.0.1", relay.port)).await.is_err());
}
