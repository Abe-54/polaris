//! A relay party for the load generator: proves its key and exchanges data frames
//! (apps/relay/README.md is the contract).

use std::sync::LazyLock;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::{BufMut, Bytes, BytesMut};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub type Failure = Box<dyn std::error::Error + Send + Sync>;

static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Nanoseconds since the load generator started; every latency is a difference of two.
pub fn now_ns() -> u64 {
    EPOCH.elapsed().as_nanos() as u64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Host,
    Device,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Device => "device",
        }
    }

    fn byte(self) -> u8 {
        match self {
            Role::Host => 1,
            Role::Device => 2,
        }
    }
}

/// A party's relay identity: an Ed25519 key and the address derived from it.
pub struct Identity {
    key: SigningKey,
    pub address: String,
}

impl Identity {
    pub fn generate() -> Self {
        let key = SigningKey::from_bytes(&rand::random::<[u8; 32]>());
        let digest = Sha256::digest(key.verifying_key().as_bytes());

        Self { key, address: URL_SAFE_NO_PAD.encode(&digest[..16]) }
    }

    /// The `auth` message answering the relay's nonce.
    fn auth(&self, nonce: &[u8], role: Role, peers: Option<&[String]>) -> String {
        let mut message = b"polaris-relay/1 auth\0".to_vec();
        message.extend_from_slice(nonce);
        message.push(role.byte());
        let signature = self.key.sign(&message);

        let mut auth = serde_json::json!({
            "t": "auth",
            "role": role.name(),
            "key": URL_SAFE_NO_PAD.encode(self.key.verifying_key().as_bytes()),
            "sig": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        });

        if let Some(peers) = peers {
            auth["peers"] = serde_json::json!(peers);
        }

        auth.to_string()
    }
}

/// A well-formed relay address nobody holds the key for.
pub fn random_address() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
}

async fn next_control(ws: &mut Ws, kind: &str) -> Result<serde_json::Value, Failure> {
    loop {
        let message = ws.next().await.ok_or("the relay closed the socket")??;

        let Message::Text(text) = message else {
            if let Message::Close(frame) = message {
                return Err(format!("the relay closed the socket: {frame:?}").into());
            }

            continue;
        };

        let value: serde_json::Value = serde_json::from_str(text.as_str())?;

        if value["t"] == kind {
            return Ok(value);
        }
    }
}

/// Opens a socket, proves `identity` as `role` and waits for `ready`.
pub async fn connect(
    url: &str,
    role: Role,
    identity: &Identity,
    peers: Option<&[String]>,
) -> Result<Ws, Failure> {
    let (mut ws, _) = tokio_tungstenite::connect_async_with_config(url, None, true).await?;
    let challenge = next_control(&mut ws, "challenge").await?;
    let nonce = URL_SAFE_NO_PAD.decode(challenge["nonce"].as_str().ok_or("no nonce")?)?;
    ws.send(Message::text(identity.auth(&nonce, role, peers))).await?;
    next_control(&mut ws, "ready").await?;

    Ok(ws)
}

/// Bytes a data frame spends before the record: version, op, length and a 22-byte address.
pub const FRAME_HEADER_BYTES: usize = 3 + 22;

/// Bytes of a record the load generator fills: send time, class and sequence number.
pub const STAMP_BYTES: usize = 8 + 1 + 4;

/// A forward to `peer` whose record is `size` bytes, stamped with now, `class` and `seq`.
pub fn stamped_frame(peer: &str, size: usize, class: u8, seq: u32) -> Bytes {
    let size = size.max(STAMP_BYTES);
    let mut frame = BytesMut::zeroed(FRAME_HEADER_BYTES + size);
    frame[0] = 1;
    frame[1] = 1;
    frame[2] = peer.len() as u8;
    frame[3..FRAME_HEADER_BYTES].copy_from_slice(peer.as_bytes());
    let mut stamp = &mut frame[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + STAMP_BYTES];
    stamp.put_u64_le(now_ns());
    stamp.put_u8(class);
    stamp.put_u32_le(seq);

    frame.freeze()
}

/// What a received data frame says about itself.
pub struct Stamp {
    pub sent_ns: u64,
    pub class: u8,
    pub seq: u32,
}

/// Reads the stamp of a frame made by `stamped_frame`; none when it is not one.
pub fn read_stamp(frame: &[u8]) -> Option<Stamp> {
    let record = frame.get(FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + STAMP_BYTES)?;

    Some(Stamp {
        sent_ns: u64::from_le_bytes(record[..8].try_into().ok()?),
        class: record[8],
        seq: u32::from_le_bytes(record[9..13].try_into().ok()?),
    })
}
