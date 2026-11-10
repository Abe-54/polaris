//! The server side of RFC 6455: the opening handshake's accept key, frame headers, and
//! unmasking in place. No extensions: the relay's payloads are ciphertext, so it never
//! negotiates compression.

use sha1::{Digest, Sha1};

use crate::wire::to_base64;

pub const OP_CONTINUATION: u8 = 0x0;
pub const OP_TEXT: u8 = 0x1;
pub const OP_BINARY: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xA;

/// Standard close codes the relay sends for protocol faults.
pub const CLOSE_PROTOCOL_ERROR: u16 = 1002;
pub const CLOSE_INVALID_DATA: u16 = 1007;
pub const CLOSE_TOO_BIG: u16 = 1009;
/// What a close without a status reads as, and what a dropped connection reads as.
pub const CLOSE_NO_STATUS: u16 = 1005;
pub const CLOSE_ABNORMAL: u16 = 1006;

/// The longest header a client frame has: 2 bytes, an 8-byte length and a 4-byte mask.
pub const MAX_HEAD_BYTES: usize = 14;

/// The longest header a server frame has: 2 bytes and an 8-byte length.
pub const MAX_SERVER_HEAD_BYTES: usize = 10;

/// The `Sec-WebSocket-Accept` value for a client's `Sec-WebSocket-Key`.
pub fn accept_key(key: &[u8]) -> String {
    let mut hash = Sha1::new();
    hash.update(key);
    hash.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");

    to_base64(&hash.finalize())
}

/// A client frame's header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Head {
    pub fin: bool,
    pub opcode: u8,
    pub mask: [u8; 4],
    /// Bytes the header itself takes; the payload follows.
    pub head_len: usize,
    pub payload_len: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Parsed {
    /// The header is not all here yet.
    Incomplete,
    Head(Head),
    /// The frame breaks the protocol; the connection ends with 1002.
    Invalid,
    /// The payload is longer than the relay accepts; the connection ends with 1009.
    TooBig,
}

/// Reads one frame header from the start of `bytes`. `max_payload` bounds a single frame.
pub fn parse_head(bytes: &[u8], max_payload: usize) -> Parsed {
    let [first, second, rest @ ..] = bytes else { return Parsed::Incomplete };
    let opcode = first & 0x0F;
    let fin = first & 0x80 != 0;
    let control = opcode >= OP_CLOSE;

    // No extension is negotiated, so reserved bits are a fault; a client always masks.
    if first & 0x70 != 0 || second & 0x80 == 0 || !known(opcode) {
        return Parsed::Invalid;
    }

    let (payload_len, length_bytes) = match second & 0x7F {
        126 => match rest {
            [a, b, ..] => (u64::from(u16::from_be_bytes([*a, *b])), 2),
            _ => return Parsed::Incomplete,
        },
        127 => match rest.first_chunk::<8>() {
            Some(length) => (u64::from_be_bytes(*length), 8),
            None => return Parsed::Incomplete,
        },
        short => (u64::from(short), 0),
    };

    // A control frame is at most 125 bytes and never fragmented.
    if control && (length_bytes != 0 || !fin) {
        return Parsed::Invalid;
    }

    if payload_len > max_payload as u64 {
        return Parsed::TooBig;
    }

    let Some(mask) = rest.get(length_bytes..).and_then(|r| r.first_chunk::<4>()) else {
        return Parsed::Incomplete;
    };

    Parsed::Head(Head {
        fin,
        opcode,
        mask: *mask,
        head_len: 2 + length_bytes + 4,
        payload_len: payload_len as usize,
    })
}

fn known(opcode: u8) -> bool {
    matches!(opcode, OP_CONTINUATION | OP_TEXT | OP_BINARY | OP_CLOSE | OP_PING | OP_PONG)
}

/// Removes a client's mask from `payload` in place, eight bytes at a time.
pub fn unmask(payload: &mut [u8], mask: [u8; 4]) {
    let wide = u64::from_ne_bytes([
        mask[0], mask[1], mask[2], mask[3], mask[0], mask[1], mask[2], mask[3],
    ]);

    let (chunks, rest) = payload.as_chunks_mut::<8>();

    for chunk in chunks {
        *chunk = (u64::from_ne_bytes(*chunk) ^ wide).to_ne_bytes();
    }

    for (index, byte) in rest.iter_mut().enumerate() {
        *byte ^= mask[index & 3];
    }
}

/// Writes the header of a whole, unmasked server frame into `out`; returns its length.
pub fn write_head(opcode: u8, payload_len: usize, out: &mut [u8; MAX_SERVER_HEAD_BYTES]) -> usize {
    out[0] = 0x80 | opcode;

    if payload_len < 126 {
        out[1] = payload_len as u8;

        2
    } else if payload_len <= usize::from(u16::MAX) {
        out[1] = 126;
        out[2..4].copy_from_slice(&(payload_len as u16).to_be_bytes());

        4
    } else {
        out[1] = 127;
        out[2..10].copy_from_slice(&(payload_len as u64).to_be_bytes());

        10
    }
}

/// Appends a whole server frame to `out`.
pub fn push_frame(out: &mut Vec<u8>, opcode: u8, payload: &[u8]) {
    let mut head = [0u8; MAX_SERVER_HEAD_BYTES];
    let head_len = write_head(opcode, payload.len(), &mut head);
    out.extend_from_slice(&head[..head_len]);
    out.extend_from_slice(payload);
}

/// Appends a close frame carrying `code` and `reason`.
pub fn push_close(out: &mut Vec<u8>, code: u16, reason: &str) {
    // A control frame's payload is at most 125 bytes: two for the code, the rest reason.
    let reason = &reason.as_bytes()[..reason.len().min(123)];
    let mut payload = Vec::with_capacity(2 + reason.len());
    payload.extend_from_slice(&code.to_be_bytes());
    payload.extend_from_slice(reason);
    push_frame(out, OP_CLOSE, &payload);
}

/// The status code of a close frame's payload: 1005 when it carries none.
pub fn close_code(payload: &[u8]) -> u16 {
    match payload {
        [a, b, ..] => u16::from_be_bytes([*a, *b]),
        _ => CLOSE_NO_STATUS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A masked client frame, as a browser or Bun sends it.
    fn client_frame(first: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
        let mut frame = vec![first];

        match payload.len() {
            n if n < 126 => frame.push(0x80 | n as u8),
            n if n <= 65_535 => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }

        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));

        frame
    }

    #[test]
    fn the_accept_key_is_rfc_6455_s_example() {
        assert_eq!(accept_key(b"dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn frames_of_every_length_form_parse_and_unmask_to_what_was_sent() {
        for size in [0usize, 1, 7, 8, 9, 125, 126, 65_535, 65_536, 65_611] {
            let payload: Vec<u8> = (0..size).map(|i| (i * 7 % 251) as u8).collect();
            let mut frame = client_frame(0x82, &payload, [0x12, 0x34, 0x56, 0x78]);
            let Parsed::Head(head) = parse_head(&frame, 65_611) else {
                panic!("a {size}-byte frame did not parse");
            };

            assert_eq!((head.fin, head.opcode, head.payload_len), (true, OP_BINARY, size));
            assert_eq!(head.head_len + head.payload_len, frame.len());
            unmask(&mut frame[head.head_len..], head.mask);
            assert_eq!(&frame[head.head_len..], &payload[..]);
        }
    }

    #[test]
    fn a_header_cut_anywhere_is_incomplete_not_a_fault() {
        let frame = client_frame(0x82, &[0u8; 70_000], [1, 2, 3, 4]);

        for cut in 0..14 {
            assert_eq!(parse_head(&frame[..cut], 100_000), Parsed::Incomplete, "cut at {cut}");
        }
    }

    #[test]
    fn faults_and_oversize_frames_are_told_apart() {
        let mask = [1, 2, 3, 4];
        // Unmasked, a reserved bit, an unknown opcode, a fragmented ping, a 126-byte ping.
        assert_eq!(parse_head(&[0x82, 0x01, 0x00], 100), Parsed::Invalid);
        assert_eq!(parse_head(&client_frame(0xC2, b"x", mask), 100), Parsed::Invalid);
        assert_eq!(parse_head(&client_frame(0x83, b"x", mask), 100), Parsed::Invalid);
        assert_eq!(parse_head(&client_frame(0x09, b"x", mask), 100), Parsed::Invalid);
        assert_eq!(parse_head(&client_frame(0x89, &[0u8; 126], mask), 1000), Parsed::Invalid);
        assert_eq!(parse_head(&client_frame(0x82, &[0u8; 101], mask), 100), Parsed::TooBig);
    }

    #[test]
    fn server_frames_use_the_shortest_length_form() {
        let mut out = Vec::new();
        push_frame(&mut out, OP_TEXT, b"hi");
        assert_eq!(out, [0x81, 2, b'h', b'i']);

        let mut head = [0u8; MAX_SERVER_HEAD_BYTES];
        assert_eq!(write_head(OP_BINARY, 126, &mut head), 4);
        assert_eq!(head[..4], [0x82, 126, 0, 126]);
        assert_eq!(write_head(OP_BINARY, 65_536, &mut head), 10);
        assert_eq!(head, [0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0]);
    }

    #[test]
    fn a_close_frame_carries_its_code_and_reason() {
        let mut out = Vec::new();
        push_close(&mut out, 4401, "auth-failed");
        assert_eq!(out[..2], [0x88, 13]);
        assert_eq!(close_code(&out[2..]), 4401);
        assert_eq!(&out[4..], b"auth-failed");
        assert_eq!(close_code(&[]), CLOSE_NO_STATUS);
    }
}
