//! The relay's wire format (apps/relay/README.md is the contract; the TypeScript source of
//! truth is packages/protocol/src/relay/wire.ts). Control messages are JSON text, data frames
//! are `version:u8 op:u8 peerLength:u8 peer:ascii payload`, and the relay reads only headers.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

pub const RELAY_WIRE_VERSION: u8 = 1;

/// The WebSocket path a party dials.
pub const RELAY_PATH: &str = "/v1";

pub const OP_FORWARD: u8 = 1;

/// The largest end-to-end record a data frame may carry.
pub const MAX_RECORD_BYTES: usize = 65_535 + 9;

/// The largest WebSocket message the relay accepts.
pub const MAX_RELAY_MESSAGE_BYTES: usize = 3 + 64 + MAX_RECORD_BYTES;

pub const NONCE_BYTES: usize = 32;

/// Characters in a relay address: 16 bytes as base64url without padding.
pub const ADDRESS_BYTES: usize = 22;

/// A data frame's header: version, op, the address's length, and the address.
pub const HEADER_BYTES: usize = 3 + ADDRESS_BYTES;

/// Why the relay closed a connection; sent as the WebSocket close code.
pub mod close {
    pub const BAD_MESSAGE: u16 = 4400;
    pub const AUTH_FAILED: u16 = 4401;
    pub const AUTH_TIMEOUT: u16 = 4408;
    pub const REPLACED: u16 = 4409;
    pub const RATE_LIMITED: u16 = 4429;
}

/// Whether each byte value is a base64url character: one lookup a byte on the forward path.
const BASE64URL: [bool; 256] = {
    let mut table = [false; 256];
    let mut byte = 0;

    while byte < 256 {
        let value = byte as u8;
        table[byte] = value.is_ascii_alphanumeric() || value == b'-' || value == b'_';
        byte += 1;
    }

    table
};

fn is_base64url(byte: u8) -> bool {
    BASE64URL[usize::from(byte)]
}

/// Whether `text` is one or more base64url characters, at most `max` of them.
fn is_base64url_text(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && text.bytes().all(is_base64url)
}

/// A party's relay address: base64url of the first 16 bytes of SHA-256 over its public key.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Address([u8; ADDRESS_BYTES]);

impl Address {
    /// The address in `bytes`, when they are exactly 22 base64url characters.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let address: [u8; ADDRESS_BYTES] = bytes.try_into().ok()?;
        // Folded without a branch a byte, so the whole check is a handful of loads.
        let valid = address.iter().fold(true, |valid, byte| valid & is_base64url(*byte));

        valid.then_some(Self(address))
    }

    pub fn of_key(public_key: &[u8]) -> Self {
        let digest = Sha256::digest(public_key);
        let mut address = [0u8; ADDRESS_BYTES];
        // 16 bytes always encode to 22 characters, so the buffer is exactly filled.
        let written = URL_SAFE_NO_PAD.encode_slice(&digest[..16], &mut address);
        debug_assert_eq!(written.ok(), Some(ADDRESS_BYTES));

        Self(address)
    }

    pub fn as_bytes(&self) -> &[u8; ADDRESS_BYTES] {
        &self.0
    }

    pub fn as_str(&self) -> &str {
        // Every byte is ASCII by construction (`parse` and `of_key`), so this never fails.
        std::str::from_utf8(&self.0).unwrap_or_default()
    }
}

impl std::fmt::Debug for Address {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Address {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <&str>::deserialize(deserializer)?;

        Address::parse(text.as_bytes())
            .ok_or_else(|| serde::de::Error::custom("not a relay address"))
    }
}

impl Serialize for Address {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Device,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Device => "device",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Sandbox,
    Production,
}

impl Environment {
    pub fn as_str(self) -> &'static str {
        match self {
            Environment::Sandbox => "sandbox",
            Environment::Production => "production",
        }
    }
}

/// What became of a wake (README: Push).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WakeOutcome {
    Sent,
    Unlinked,
    RateLimited,
    Unregistered,
    Refused,
    Unavailable,
}

impl WakeOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            WakeOutcome::Sent => "sent",
            WakeOutcome::Unlinked => "unlinked",
            WakeOutcome::RateLimited => "rate-limited",
            WakeOutcome::Unregistered => "unregistered",
            WakeOutcome::Refused => "refused",
            WakeOutcome::Unavailable => "unavailable",
        }
    }
}

/// A string that must match a pattern; `check` is that pattern.
fn checked<'de, D: Deserializer<'de>>(
    deserializer: D,
    what: &'static str,
    check: fn(&str) -> bool,
) -> Result<String, D::Error> {
    let text = String::deserialize(deserializer)?;

    if check(&text) { Ok(text) } else { Err(serde::de::Error::custom(what)) }
}

fn wake_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    checked(deserializer, "not a wake id", |text| is_base64url_text(text, 32))
}

/// An APNs device token: 64 to 200 lowercase hex characters.
fn apns_token<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    checked(deserializer, "not an APNs token", |text| {
        (64..=200).contains(&text.len())
            && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn wake_payload<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    checked(deserializer, "not a sealed payload", |text| is_base64url_text(text, 3000))
}

/// A sealed slice, or null to leave the activity. The key must be present.
fn live_slice<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        Some(text) if is_base64url_text(&text, 560) => Ok(Some(text)),
        Some(_) => Err(serde::de::Error::custom("not a sealed slice")),
        None => Ok(None),
    }
}

/// A list of peers that, when the key is present, is a list and never null.
fn listed<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<Address>>, D::Error> {
    Vec::<Address>::deserialize(deserializer).map(Some)
}

/// A device's consent for one host: its relay key and a signature (README: Push).
#[derive(Debug, Deserialize)]
pub struct Ticket {
    pub key: String,
    pub sig: String,
}

#[derive(Debug, Deserialize)]
pub struct Auth {
    pub role: Role,
    pub key: String,
    pub sig: String,
    #[serde(default, deserialize_with = "listed")]
    pub peers: Option<Vec<Address>>,
}

#[derive(Debug, Deserialize)]
pub struct Wake {
    #[serde(deserialize_with = "wake_id")]
    pub id: String,
    pub peer: Address,
    #[serde(deserialize_with = "apns_token")]
    pub token: String,
    pub environment: Environment,
    pub ticket: Ticket,
    #[serde(deserialize_with = "wake_payload")]
    pub payload: String,
}

#[derive(Debug, Deserialize)]
pub struct Live {
    pub peer: Address,
    #[serde(deserialize_with = "apns_token")]
    pub token: String,
    pub environment: Environment,
    pub ticket: Ticket,
    #[serde(deserialize_with = "live_slice")]
    pub slice: Option<String>,
    pub active: bool,
    pub alert: bool,
}

/// A control message from a party.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientControl {
    Auth(Auth),
    Peers { peers: Vec<Address> },
    Wake(Wake),
    Live(Live),
}

pub fn decode_client_control(text: &[u8]) -> Option<ClientControl> {
    serde_json::from_slice(text).ok()
}

pub fn presence(peer: &Address, online: bool) -> String {
    format!(r#"{{"t":"presence","peer":"{}","online":{online}}}"#, peer.as_str())
}

pub fn unreachable(peer: &Address) -> String {
    format!(r#"{{"t":"unreachable","peer":"{}"}}"#, peer.as_str())
}

pub fn ready(address: &Address) -> String {
    format!(r#"{{"t":"ready","address":"{}"}}"#, address.as_str())
}

/// `id` matched the wake id pattern when it was decoded, so it needs no escaping.
pub fn woken(id: &str, outcome: WakeOutcome) -> String {
    format!(r#"{{"t":"woken","id":"{id}","outcome":"{}"}}"#, outcome.as_str())
}

/// `token` matched the APNs token pattern when it was decoded, so it needs no escaping.
pub fn live_gone(token: &str, outcome: &str) -> String {
    format!(r#"{{"t":"live-gone","token":"{token}","outcome":"{outcome}"}}"#)
}

/// Accepts padded or unpadded base64url, as the TypeScript relay's decoder does.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

pub fn from_base64url(text: &str) -> Option<Vec<u8>> {
    let stripped: String = text.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let body = stripped.trim_end_matches('=');
    let given = stripped.len() - body.len();

    // Padding the length calls for but the text left out; one over a multiple of 4 has none.
    let missing = match stripped.len() % 4 {
        1 => return None,
        2 => 2,
        3 => 1,
        _ => 0,
    };

    if given + missing > 2 || !body.bytes().all(is_base64url) {
        return None;
    }

    LENIENT.decode(body).ok()
}

pub fn to_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// The bytes a party signs to prove its key: a fixed context, the relay's nonce and the role.
pub fn auth_message(nonce: &[u8], role: Role) -> Vec<u8> {
    let mut message = b"polaris-relay/1 auth\0".to_vec();
    message.extend_from_slice(nonce);
    message.push(if role == Role::Host { 1 } else { 2 });

    message
}

/// Whether `signature` is `public_key`'s Ed25519 signature over `message`.
pub fn verify_ed25519(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let (Ok(key), Ok(signature)) =
        (<&[u8; 32]>::try_from(public_key), <&[u8; 64]>::try_from(signature))
    else {
        return false;
    };

    let Ok(key) = VerifyingKey::from_bytes(key) else { return false };

    key.verify_strict(message, &Signature::from_bytes(signature)).is_ok()
}

/// Whether `ticket` is `peer`'s consent for `host` at this token, under `context`.
fn verify_ticket(
    context: &str,
    ticket: &Ticket,
    peer: &Address,
    host: &Address,
    environment: Environment,
    token: &str,
) -> bool {
    let (Some(key), Some(signature)) = (from_base64url(&ticket.key), from_base64url(&ticket.sig))
    else {
        return false;
    };

    if key.len() != 32 || Address::of_key(&key) != *peer {
        return false;
    }

    let message = format!("{context}\0{}\0{}\0{token}", host.as_str(), environment.as_str());

    verify_ed25519(&key, message.as_bytes(), &signature)
}

/// Whether `ticket` lets `host` wake `peer` at `token`.
pub fn verify_push_ticket(
    ticket: &Ticket,
    peer: &Address,
    host: &Address,
    environment: Environment,
    token: &str,
) -> bool {
    verify_ticket("polaris-push-ticket/1", ticket, peer, host, environment, token)
}

/// Whether `ticket` lets `host` update `peer`'s Live Activity at `token`.
pub fn verify_live_ticket(
    ticket: &Ticket,
    peer: &Address,
    host: &Address,
    environment: Environment,
    token: &str,
) -> bool {
    verify_ticket("polaris-live-ticket/1", ticket, peer, host, environment, token)
}

/// The destination of a well-formed forward, or none. Reads the header only.
pub fn forward_peer(message: &[u8]) -> Option<Address> {
    if message.len() < HEADER_BYTES
        || message[0] != RELAY_WIRE_VERSION
        || message[1] != OP_FORWARD
        || usize::from(message[2]) != ADDRESS_BYTES
        || message.len() - HEADER_BYTES > MAX_RECORD_BYTES
    {
        return None;
    }

    Address::parse(&message[3..HEADER_BYTES])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const ADDRESS: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    fn frame(version: u8, op: u8, peer: &[u8], record: usize) -> Vec<u8> {
        let mut frame = vec![version, op, peer.len() as u8];
        frame.extend_from_slice(peer);
        frame.resize(frame.len() + record, 0);

        frame
    }

    #[test]
    fn a_forward_names_its_peer_and_every_malformed_header_is_refused() {
        let peer = Address::parse(ADDRESS.as_bytes());
        assert!(peer.is_some());
        assert_eq!(forward_peer(&frame(1, 1, ADDRESS.as_bytes(), 16)), peer);
        assert_eq!(forward_peer(&frame(1, 1, ADDRESS.as_bytes(), MAX_RECORD_BYTES)), peer);

        let refused = [
            frame(2, 1, ADDRESS.as_bytes(), 16),
            frame(1, 2, ADDRESS.as_bytes(), 16),
            frame(1, 1, &ADDRESS.as_bytes()[1..], 16),
            frame(1, 1, b"AAAAAAAAAAAAAAAAAAAAAAA", 16),
            frame(1, 1, b"AAAAAAAAAAAAAAAAAAAAA/", 16),
            frame(1, 1, "AAAAAAAAAAAAAAAAAAAA\u{e9}".as_bytes(), 16),
            frame(1, 1, ADDRESS.as_bytes(), 16)[..20].to_vec(),
            frame(1, 1, ADDRESS.as_bytes(), MAX_RECORD_BYTES + 1),
            vec![9, 1, 1, 65],
            vec![],
        ];

        for bad in refused {
            assert_eq!(forward_peer(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn an_address_is_the_hash_of_its_key_and_22_base64url_characters() {
        // What packages/protocol's `relayAddress` gives for 32 zero bytes.
        let address = Address::of_key(&[0u8; 32]);
        assert_eq!(address.as_str(), "Zmh6rfhivXdsj8GLjp-OIA");
        assert_eq!(Address::parse(address.as_str().as_bytes()), Some(address));
        assert_eq!(Address::parse(b"../etc"), None);
    }

    #[test]
    fn a_proof_verifies_for_its_nonce_and_role_only() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let public = key.verifying_key().to_bytes();
        let nonce = [3u8; 32];
        let proof = key.sign(&auth_message(&nonce, Role::Host)).to_bytes();

        assert!(verify_ed25519(&public, &auth_message(&nonce, Role::Host), &proof));
        assert!(!verify_ed25519(&public, &auth_message(&nonce, Role::Device), &proof));
        assert!(!verify_ed25519(&public, &auth_message(&[4u8; 32], Role::Host), &proof));
        assert!(!verify_ed25519(&[0u8; 32], &auth_message(&nonce, Role::Host), &[0u8; 64]));
        assert!(!verify_ed25519(&[0u8; 5], &auth_message(&nonce, Role::Host), &proof));
    }

    #[test]
    fn a_ticket_is_one_device_s_consent_for_one_host_token_and_purpose() {
        let device = SigningKey::from_bytes(&[9u8; 32]);
        let peer = Address::of_key(device.verifying_key().as_bytes());
        let host = Address::of_key(&[1u8; 32]);
        let other = Address::of_key(&[2u8; 32]);
        let token = "a1".repeat(32);
        let message = format!("polaris-push-ticket/1\0{}\0sandbox\0{token}", host.as_str());

        let ticket = Ticket {
            key: to_base64url(device.verifying_key().as_bytes()),
            sig: to_base64url(&device.sign(message.as_bytes()).to_bytes()),
        };

        assert!(verify_push_ticket(&ticket, &peer, &host, Environment::Sandbox, &token));
        assert!(!verify_push_ticket(&ticket, &peer, &other, Environment::Sandbox, &token));
        assert!(!verify_push_ticket(&ticket, &other, &host, Environment::Sandbox, &token));
        assert!(!verify_push_ticket(&ticket, &peer, &host, Environment::Production, &token));
        assert!(!verify_push_ticket(&ticket, &peer, &host, Environment::Sandbox, &"b2".repeat(32)));
        assert!(!verify_live_ticket(&ticket, &peer, &host, Environment::Sandbox, &token));
    }

    #[test]
    fn control_decoding_refuses_unknown_messages_and_malformed_fields() {
        assert!(decode_client_control(br#"{"t":"peers","peers":[]}"#).is_some());
        assert!(decode_client_control(br#"{"t":"peers","peers":["../etc"]}"#).is_none());
        assert!(decode_client_control(br#"{"t":"ready","address":"x"}"#).is_none());
        assert!(decode_client_control(b"not json").is_none());
        assert!(
            decode_client_control(br#"{"t":"auth","role":"host","key":"k","sig":"s"}"#).is_some()
        );
        assert!(
            decode_client_control(
                br#"{"t":"auth","role":"host","key":"k","sig":"s","peers":null}"#
            )
            .is_none()
        );
        assert!(
            decode_client_control(br#"{"t":"auth","role":"root","key":"k","sig":"s"}"#).is_none()
        );

        let live = |slice: &str| {
            format!(
                r#"{{"t":"live","peer":"{ADDRESS}","token":"{}","environment":"sandbox","ticket":{{"key":"k","sig":"s"}}{slice},"active":true,"alert":false}}"#,
                "b2".repeat(40)
            )
        };

        assert!(decode_client_control(live(r#","slice":"abc""#).as_bytes()).is_some());
        assert!(decode_client_control(live(r#","slice":null"#).as_bytes()).is_some());
        assert!(decode_client_control(live("").as_bytes()).is_none());
        assert!(decode_client_control(live(r#","slice":"a b""#).as_bytes()).is_none());
    }

    #[test]
    fn base64url_decodes_padded_and_unpadded_and_refuses_the_rest() {
        assert_eq!(from_base64url("AQID"), Some(vec![1, 2, 3]));
        assert_eq!(from_base64url("AQI"), Some(vec![1, 2]));
        assert_eq!(from_base64url("AQI="), Some(vec![1, 2]));
        assert_eq!(from_base64url("AQ=="), Some(vec![1]));
        assert_eq!(from_base64url("AQ\n=="), Some(vec![1]));
        assert_eq!(from_base64url("A"), None);
        assert_eq!(from_base64url("AQI+"), None);
        assert_eq!(from_base64url("AQID="), None);
        assert_eq!(from_base64url("AQ="), Some(vec![1]));
        assert_eq!(from_base64url("A="), None);
        assert_eq!(from_base64url("AQ==="), None);
    }
}
