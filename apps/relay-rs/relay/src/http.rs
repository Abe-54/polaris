//! The HTTP the relay speaks before a socket is a WebSocket: the upgrade request on `/v1`,
//! the health check, and plain refusals.

use crate::ws;

/// The longest request head the relay reads before it gives up on the request.
pub const MAX_HEAD_BYTES: usize = 16 * 1024;

const MAX_HEADERS: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub struct Head {
    /// Bytes the head takes, up to and including its blank line.
    pub len: usize,
    /// The request target's path, without its query.
    pub path: String,
    /// The `Sec-WebSocket-Accept` value, when this is a WebSocket upgrade request.
    pub accept: Option<String>,
    /// The first `X-Forwarded-For` hop, when the header names one.
    pub forwarded_for: Option<String>,
    /// Whether the connection may carry another request after this one's reply.
    pub keep_alive: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Incomplete,
    Invalid,
    Head(Head),
}

fn has_token(value: &[u8], token: &str) -> bool {
    value
        .split(|byte| *byte == b',')
        .any(|part| part.trim_ascii().eq_ignore_ascii_case(token.as_bytes()))
}

fn path_of(target: &str) -> &str {
    // An absolute-form target carries its scheme and authority before the path.
    let origin = match target.find("://") {
        Some(scheme) => {
            target[scheme + 3..].find('/').map_or("/", |slash| &target[scheme + 3 + slash..])
        }
        None => target,
    };

    origin.split(['?', '#']).next().unwrap_or(origin)
}

#[derive(Default)]
struct Seen<'a> {
    upgrade: bool,
    connection_upgrade: bool,
    close: bool,
    version_13: bool,
    key: Option<&'a [u8]>,
    forwarded_for: Option<&'a [u8]>,
    body: bool,
}

impl<'a> Seen<'a> {
    fn header(&mut self, name: &str, value: &'a [u8]) {
        match name.to_ascii_lowercase().as_str() {
            "upgrade" => self.upgrade = has_token(value, "websocket"),
            "connection" => {
                self.connection_upgrade |= has_token(value, "upgrade");
                self.close |= has_token(value, "close");
            }
            "sec-websocket-version" => self.version_13 = value.trim_ascii() == b"13",
            "sec-websocket-key" => self.key = Some(value.trim_ascii()),
            "x-forwarded-for" if self.forwarded_for.is_none() => self.forwarded_for = Some(value),
            "content-length" => self.body |= value.trim_ascii() != b"0",
            "transfer-encoding" => self.body = true,
            _ => {}
        }
    }
}

/// Reads one request head from the start of `bytes`.
pub fn parse(bytes: &[u8]) -> Parsed {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);

    let len = match request.parse(bytes) {
        Ok(httparse::Status::Complete(len)) => len,
        Ok(httparse::Status::Partial) => return Parsed::Incomplete,
        Err(_) => return Parsed::Invalid,
    };

    let mut seen = Seen::default();

    for header in request.headers.iter() {
        seen.header(header.name, header.value);
    }

    let get = request.method == Some("GET");
    let current = request.version == Some(1);
    let key = seen.key.filter(|key| !key.is_empty());
    let upgrade = get && current && seen.upgrade && seen.connection_upgrade && seen.version_13;

    let first_hop = seen
        .forwarded_for
        .and_then(|value| value.split(|byte| *byte == b',').next())
        .map(|hop| String::from_utf8_lossy(hop.trim_ascii()).into_owned())
        .filter(|hop| !hop.is_empty());

    Parsed::Head(Head {
        len,
        path: path_of(request.path.unwrap_or("/")).to_owned(),
        accept: key.filter(|_| upgrade).map(ws::accept_key),
        forwarded_for: first_hop,
        // The relay reads no request bodies, so a request with one ends the connection.
        keep_alive: current && !seen.close && !seen.body,
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        426 => "Upgrade Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    }
}

/// A plain-text reply.
pub fn response(status: u16, body: &str, keep_alive: bool) -> Vec<u8> {
    let connection = if keep_alive { "" } else { "Connection: close\r\n" };

    format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: text/plain;charset=utf-8\r\nContent-Length: {}\r\n{connection}\r\n{body}",
        reason(status),
        body.len()
    )
    .into_bytes()
}

/// The reply that makes the socket a WebSocket.
pub fn switching(accept: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPGRADE: &str = "GET /v1 HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

    fn head(text: &str) -> Head {
        match parse(text.as_bytes()) {
            Parsed::Head(head) => head,
            other => panic!("expected a head, got {other:?}"),
        }
    }

    #[test]
    fn an_upgrade_request_gets_rfc_6455_s_accept_key_and_leaves_what_follows_it() {
        let request = format!("{UPGRADE}\u{1}\u{2}");
        let parsed = head(&request);

        assert_eq!(parsed.accept.as_deref(), Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
        assert_eq!((parsed.len, parsed.path.as_str()), (UPGRADE.len(), "/v1"));
    }

    #[test]
    fn a_request_missing_any_part_of_the_upgrade_is_not_one() {
        for missing in [
            "Upgrade: websocket\r\n",
            "Connection: keep-alive, Upgrade\r\n",
            "Sec-WebSocket-Version: 13\r\n",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
        ] {
            assert_eq!(head(&UPGRADE.replace(missing, "")).accept, None, "{missing}");
        }

        assert_eq!(head(&UPGRADE.replace("GET", "POST")).accept, None);
        assert_eq!(head(&UPGRADE.replace("Version: 13", "Version: 8")).accept, None);
    }

    #[test]
    fn the_path_is_the_target_without_its_query_or_origin() {
        assert_eq!(head("GET /healthz?probe=1 HTTP/1.1\r\n\r\n").path, "/healthz");
        assert_eq!(head("GET http://relay.example/v1?x HTTP/1.1\r\n\r\n").path, "/v1");
        assert_eq!(head("GET http://relay.example HTTP/1.1\r\n\r\n").path, "/");
    }

    #[test]
    fn the_first_forwarded_hop_is_the_client() {
        let request = "GET /v1 HTTP/1.1\r\nX-Forwarded-For: 203.0.113.7 , 10.0.0.1\r\n\r\n";

        assert_eq!(head(request).forwarded_for.as_deref(), Some("203.0.113.7"));
        assert_eq!(head("GET /v1 HTTP/1.1\r\nX-Forwarded-For:  \r\n\r\n").forwarded_for, None);
    }

    #[test]
    fn a_connection_stays_open_unless_the_request_closes_it_or_carries_a_body() {
        assert!(head("GET /healthz HTTP/1.1\r\n\r\n").keep_alive);
        assert!(!head("GET /healthz HTTP/1.1\r\nConnection: close\r\n\r\n").keep_alive);
        assert!(!head("GET /healthz HTTP/1.0\r\n\r\n").keep_alive);
        assert!(!head("POST /healthz HTTP/1.1\r\nContent-Length: 4\r\n\r\n").keep_alive);
    }

    #[test]
    fn a_head_cut_short_waits_and_a_malformed_one_is_refused() {
        assert_eq!(parse(&UPGRADE.as_bytes()[..40]), Parsed::Incomplete);
        assert_eq!(parse(b"NOT HTTP\r\n\r\n"), Parsed::Invalid);
    }
}
