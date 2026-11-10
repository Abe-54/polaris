//! Abuse limits: token buckets for rates and a per-address gate on connections.

use std::collections::HashMap;

use crate::wire::Address;

/// Refills `per_second` tokens a second up to `burst`; `take` fails without spending when short.
#[derive(Debug)]
pub struct TokenBucket {
    per_second: f64,
    burst: f64,
    tokens: f64,
    last_ms: f64,
}

impl TokenBucket {
    pub fn new(per_second: f64, burst: f64, now_ms: f64) -> Self {
        Self { per_second, burst, tokens: burst, last_ms: now_ms }
    }

    pub fn take(&mut self, count: f64, now_ms: f64) -> bool {
        let refill = (now_ms - self.last_ms) / 1000.0 * self.per_second;
        self.tokens = self.burst.min(self.tokens + refill);
        self.last_ms = now_ms;

        if self.tokens < count {
            return false;
        }

        self.tokens -= count;

        true
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GateLimits {
    pub max_connections: usize,
    pub max_connections_per_ip: usize,
    pub connects_per_second_per_ip: f64,
    pub connect_burst_per_ip: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    RelayFull,
    TooManyConnections,
    ConnectingTooFast,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::RelayFull => "relay-full",
            Refusal::TooManyConnections => "too-many-connections",
            Refusal::ConnectingTooFast => "connecting-too-fast",
        }
    }

    /// The HTTP status a refused upgrade gets.
    pub fn status(self) -> u16 {
        if self == Refusal::RelayFull { 503 } else { 429 }
    }
}

struct IpState {
    open: usize,
    bucket: TokenBucket,
}

/// Admits connections. Network addresses live here only while a connection is open or its
/// bucket is still refilling; they are never logged.
pub struct ConnectionGate {
    limits: GateLimits,
    open: usize,
    ips: HashMap<String, IpState>,
}

impl ConnectionGate {
    pub fn new(limits: GateLimits) -> Self {
        Self { limits, open: 0, ips: HashMap::new() }
    }

    pub fn admit(&mut self, ip: &str, now_ms: f64) -> Option<Refusal> {
        if self.open >= self.limits.max_connections {
            return Some(Refusal::RelayFull);
        }

        let limits = self.limits;

        let state = self.ips.entry(ip.to_owned()).or_insert_with(|| IpState {
            open: 0,
            bucket: TokenBucket::new(
                limits.connects_per_second_per_ip,
                limits.connect_burst_per_ip,
                now_ms,
            ),
        });

        if state.open >= limits.max_connections_per_ip {
            return Some(Refusal::TooManyConnections);
        }

        if !state.bucket.take(1.0, now_ms) {
            return Some(Refusal::ConnectingTooFast);
        }

        state.open += 1;
        self.open += 1;

        None
    }

    pub fn release(&mut self, ip: &str) {
        let Some(state) = self.ips.get_mut(ip) else { return };
        state.open = state.open.saturating_sub(1);
        self.open = self.open.saturating_sub(1);
    }

    /// Forgets addresses with nothing open, so the map does not grow with every visitor.
    pub fn sweep(&mut self) {
        self.ips.retain(|_, state| state.open > 0);
    }

    pub fn connections(&self) -> usize {
        self.open
    }
}

/// Wake budgets per host relay address, so reconnecting doesn't refill them. An entry goes
/// once it has been idle long enough to have refilled, when it would be new again anyway.
pub struct WakeLimiter {
    per_minute: f64,
    burst: f64,
    buckets: HashMap<Address, (TokenBucket, f64)>,
}

impl WakeLimiter {
    pub fn new(per_minute: f64, burst: f64) -> Self {
        Self { per_minute, burst, buckets: HashMap::new() }
    }

    pub fn take(&mut self, address: Address, now_ms: f64) -> bool {
        let (per_minute, burst) = (self.per_minute, self.burst);

        let entry = self
            .buckets
            .entry(address)
            .or_insert_with(|| (TokenBucket::new(per_minute / 60.0, burst, now_ms), 0.0));

        entry.1 = now_ms;

        entry.0.take(1.0, now_ms)
    }

    pub fn sweep(&mut self, now_ms: f64) {
        let refill_ms = self.burst / self.per_minute * 60_000.0;
        self.buckets.retain(|_, (_, last)| now_ms - *last <= refill_ms);
    }

    #[cfg(test)]
    pub fn size(&self) -> usize {
        self.buckets.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_bucket_refuses_past_its_burst_and_refills_with_time() {
        let mut bucket = TokenBucket::new(10.0, 20.0, 0.0);

        assert_eq!((0..25).filter(|_| bucket.take(1.0, 0.0)).count(), 20);
        assert_eq!((0..10).filter(|_| bucket.take(1.0, 500.0)).count(), 5);
    }

    #[test]
    fn a_take_that_is_refused_spends_nothing() {
        let mut bucket = TokenBucket::new(1.0, 10.0, 0.0);

        assert!(!bucket.take(11.0, 0.0));
        assert!(bucket.take(10.0, 0.0));
    }

    #[test]
    fn the_gate_refuses_a_fast_connector_and_a_full_relay() {
        let mut gate = ConnectionGate::new(GateLimits {
            max_connections: 3,
            max_connections_per_ip: 10,
            connects_per_second_per_ip: 1.0,
            connect_burst_per_ip: 2.0,
        });

        assert_eq!(gate.admit("a", 0.0), None);
        assert_eq!(gate.admit("a", 0.0), None);
        assert_eq!(gate.admit("a", 0.0), Some(Refusal::ConnectingTooFast));
        assert_eq!(gate.admit("a", 1000.0), None);
        assert_eq!(gate.admit("b", 1000.0), Some(Refusal::RelayFull));
        gate.release("a");
        assert_eq!(gate.admit("b", 1000.0), None);
        assert_eq!(gate.connections(), 3);
    }

    #[test]
    fn the_gate_caps_one_address_and_frees_it_on_release() {
        let mut gate = ConnectionGate::new(GateLimits {
            max_connections: 100,
            max_connections_per_ip: 2,
            connects_per_second_per_ip: 100.0,
            connect_burst_per_ip: 100.0,
        });

        assert_eq!(gate.admit("a", 0.0), None);
        assert_eq!(gate.admit("a", 0.0), None);
        assert_eq!(gate.admit("a", 0.0), Some(Refusal::TooManyConnections));
        assert_eq!(gate.admit("b", 0.0), None);
        gate.release("a");
        assert_eq!(gate.admit("a", 0.0), None);
        gate.release("b");
        gate.sweep();
        assert_eq!(gate.connections(), 2);
    }

    #[test]
    fn a_wake_budget_survives_until_it_would_have_refilled() {
        let host = Address::of_key(&[1u8; 32]);
        let mut wakes = WakeLimiter::new(60.0, 2.0);

        assert!(wakes.take(host, 0.0));
        assert!(wakes.take(host, 0.0));
        assert!(!wakes.take(host, 0.0));
        wakes.sweep(1_000.0);
        assert_eq!(wakes.size(), 1);
        assert!(wakes.take(host, 1_000.0));
        wakes.sweep(3_100.0);
        assert_eq!(wakes.size(), 0);
    }
}
