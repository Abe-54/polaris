//! Wide events: one structured line per connection, written when it closes, plus start,
//! refusal, wake and live lines. They carry counts and opaque connection IDs only: no
//! payloads, relay addresses, keys or network addresses.

use std::io::Write;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "event")]
pub enum Event {
    #[serde(rename = "relay.connection", rename_all = "camelCase")]
    Connection {
        /// Random per connection; meaningless outside this line.
        conn: String,
        role: Option<&'static str>,
        authenticated: bool,
        duration_ms: u64,
        frames_in: u64,
        bytes_in: u64,
        frames_out: u64,
        bytes_out: u64,
        control_in: u64,
        unreachable: u64,
        dropped: u64,
        /// Wakes the host asked for on this socket.
        wakes: u64,
        close_code: u16,
        /// Why the relay closed it, or "peer" when the other end did.
        ended_by: &'static str,
    },
    #[serde(rename = "relay.refused")]
    Refused { reason: &'static str },
    #[serde(rename = "relay.start")]
    Start { port: u16 },
    /// One wake's outcome. Never the token, the payload or which host or device asked.
    #[serde(rename = "relay.wake", rename_all = "camelCase")]
    Wake { outcome: &'static str, duration_ms: u64 },
    /// One merged Live Activity push: its outcome, how many hosts it carried, and its alert.
    #[serde(rename = "relay.live")]
    Live { outcome: &'static str, hosts: usize, alert: bool },
}

#[derive(Serialize)]
struct Line<'a> {
    time: String,
    #[serde(flatten)]
    event: &'a Event,
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    (year, month, day)
}

/// `ms` since the Unix epoch as JavaScript's `toISOString` writes it.
pub fn iso_time(ms: u64) -> String {
    let seconds = ms / 1000;
    let (year, month, day) = civil((seconds / 86_400) as i64);
    let of_day = seconds % 86_400;

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
        ms % 1000
    )
}

pub fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

pub fn line(event: &Event, ms: u64) -> String {
    serde_json::to_string(&Line { time: iso_time(ms), event }).unwrap_or_default()
}

/// Where event lines go. A line is written whole before `emit` returns, so a connection's
/// line is on its way before that connection's close frame is.
#[derive(Clone)]
pub struct Events {
    sink: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Events {
    pub fn stdout() -> Self {
        Self::to(Box::new(std::io::stdout()))
    }

    pub fn to(sink: Box<dyn Write + Send>) -> Self {
        Self { sink: Arc::new(Mutex::new(sink)) }
    }

    pub fn emit(&self, event: &Event) {
        let mut text = line(event, unix_ms());
        text.push('\n');
        let mut sink = self.sink.lock().unwrap_or_else(PoisonError::into_inner);
        // A log that can't be written must not take the relay down with it.
        let _ = sink.write_all(text.as_bytes()).and_then(|()| sink.flush());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_written_as_javascript_writes_them() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_time(1_794_252_685_123), "2026-11-09T19:31:25.123Z");
        assert_eq!(iso_time(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn a_connection_line_has_the_fields_the_typescript_relay_writes() {
        let event = Event::Connection {
            conn: "abc".into(),
            role: Some("device"),
            authenticated: true,
            duration_ms: 12,
            frames_in: 1,
            bytes_in: 2,
            frames_out: 3,
            bytes_out: 4,
            control_in: 5,
            unreachable: 6,
            dropped: 7,
            wakes: 8,
            close_code: 1000,
            ended_by: "peer",
        };

        assert_eq!(
            line(&event, 0),
            concat!(
                r#"{"time":"1970-01-01T00:00:00.000Z","event":"relay.connection","conn":"abc","#,
                r#""role":"device","authenticated":true,"durationMs":12,"framesIn":1,"bytesIn":2,"#,
                r#""framesOut":3,"bytesOut":4,"controlIn":5,"unreachable":6,"dropped":7,"wakes":8,"#,
                r#""closeCode":1000,"endedBy":"peer"}"#
            )
        );
        assert_eq!(
            line(&Event::Wake { outcome: "sent", duration_ms: 3 }, 0),
            r#"{"time":"1970-01-01T00:00:00.000Z","event":"relay.wake","outcome":"sent","durationMs":3}"#
        );
    }
}
