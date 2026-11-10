//! Asks the push service (apps/site's `/api/push`) to deliver a host's wake or a merged
//! Live Activity update. Each request is signed with the shared secret over method, path,
//! timestamp, nonce and body (README: Push). Sealed payloads pass through unread and unlogged.

use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::PushConfig;
use crate::wire::{Environment, WakeOutcome, to_base64url};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub const TIMESTAMP_HEADER: &str = "x-polaris-timestamp";
pub const NONCE_HEADER: &str = "x-polaris-nonce";
pub const SIGNATURE_HEADER: &str = "x-polaris-signature";

/// What the relay asks the push service to deliver. No relay address, no content.
#[derive(Debug, Serialize)]
pub struct PushRequest<'a> {
    pub token: &'a str,
    pub environment: Environment,
    pub payload: &'a str,
}

#[derive(Debug, Serialize)]
struct LiveState<'a> {
    v: u8,
    slices: &'a [String],
}

#[derive(Debug, Serialize)]
struct LiveUpdate<'a> {
    event: &'static str,
    timestamp: u64,
    state: LiveState<'a>,
    alert: bool,
}

#[derive(Debug, Serialize)]
struct LiveRequest<'a> {
    token: &'a str,
    environment: Environment,
    live: LiveUpdate<'a>,
}

/// The body of a wake.
pub fn wake_body(request: &PushRequest<'_>) -> String {
    serde_json::to_string(request).unwrap_or_default()
}

/// The body of one merged Live Activity update, sent at `timestamp` (Unix seconds).
pub fn live_body(
    token: &str,
    environment: Environment,
    timestamp: u64,
    slices: &[String],
    alert: bool,
) -> String {
    let live = LiveUpdate { event: "update", timestamp, state: LiveState { v: 1, slices }, alert };

    serde_json::to_string(&LiveRequest { token, environment, live }).unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The text the relay signs: method, path, timestamp, nonce and the body's SHA-256.
pub fn signing_input(method: &str, path: &str, timestamp: &str, nonce: &str, body: &str) -> String {
    let body_hash = hex(&Sha256::digest(body.as_bytes()));

    ["polaris-push/1", method, path, timestamp, nonce, &body_hash].join("\n")
}

/// HMAC-SHA256 of `input` under the shared secret, base64url.
pub fn sign(secret: &str, input: &str) -> String {
    // HMAC takes a key of any length, so this never fails.
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return String::new();
    };

    mac.update(input.as_bytes());

    to_base64url(&mac.finalize().into_bytes())
}

#[derive(Deserialize)]
struct Reply {
    outcome: WakeOutcome,
}

/// The service names the outcome; a reply without one is judged by its status.
pub fn outcome_of(status: u16, text: &str) -> WakeOutcome {
    match serde_json::from_str::<Reply>(text) {
        Ok(reply) => reply.outcome,
        Err(_) if status == 429 => WakeOutcome::RateLimited,
        Err(_) if status >= 500 => WakeOutcome::Unavailable,
        Err(_) => WakeOutcome::Refused,
    }
}

pub struct PushClient {
    http: reqwest::Client,
    url: reqwest::Url,
    secret: String,
}

impl PushClient {
    pub fn new(config: &PushConfig) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("push client: {error}"))?;

        Ok(Self { http, url: config.url.clone(), secret: config.secret.clone() })
    }

    /// Sends `body`, signed, at `now_ms`; anything that goes wrong on the way is unavailable.
    pub async fn deliver(&self, body: String, now_ms: u64) -> WakeOutcome {
        let timestamp = (now_ms / 1000).to_string();
        let nonce = to_base64url(&rand::random::<[u8; 16]>());
        let input = signing_input("POST", self.url.path(), &timestamp, &nonce, &body);

        let sent = self
            .http
            .post(self.url.clone())
            .header("content-type", "application/json")
            .header(TIMESTAMP_HEADER, timestamp)
            .header(NONCE_HEADER, nonce)
            .header(SIGNATURE_HEADER, sign(&self.secret, &input))
            .body(body)
            .send()
            .await;

        let Ok(response) = sent else { return WakeOutcome::Unavailable };
        let status = response.status().as_u16();

        match response.text().await {
            Ok(text) => outcome_of(status, &text),
            Err(_) => WakeOutcome::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_signed_as_the_push_service_verifies_it() {
        // The vector comes from `signPushRequest` in packages/protocol/src/relay/push.ts.
        let input = signing_input("POST", "/api/push", "1794252685", "bm9uY2U", r#"{"a":1}"#);

        assert_eq!(
            input,
            "polaris-push/1\nPOST\n/api/push\n1794252685\nbm9uY2U\n015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
        );
        assert_eq!(sign("test-secret", &input), "BkGC1LVZnlAn-zLml-0DJbpIkllQkdvvg3YM-HgYMbM");
    }

    #[test]
    fn bodies_are_the_json_the_push_service_decodes() {
        let wake = PushRequest { token: "a1", environment: Environment::Sandbox, payload: "cGF5" };

        assert_eq!(wake_body(&wake), r#"{"token":"a1","environment":"sandbox","payload":"cGF5"}"#);
        assert_eq!(
            live_body("b2", Environment::Production, 7, &["s1".to_owned(), "s2".to_owned()], true),
            r#"{"token":"b2","environment":"production","live":{"event":"update","timestamp":7,"state":{"v":1,"slices":["s1","s2"]},"alert":true}}"#
        );
    }

    #[test]
    fn a_reply_without_an_outcome_is_judged_by_its_status() {
        assert_eq!(outcome_of(410, r#"{"outcome":"unregistered"}"#), WakeOutcome::Unregistered);
        assert_eq!(outcome_of(200, r#"{"outcome":"sent","more":1}"#), WakeOutcome::Sent);
        assert_eq!(outcome_of(503, "no json"), WakeOutcome::Unavailable);
        assert_eq!(outcome_of(429, "no json"), WakeOutcome::RateLimited);
        assert_eq!(outcome_of(401, r#"{"outcome":"delivered"}"#), WakeOutcome::Refused);
    }
}
