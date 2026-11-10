//! The relay's settings, from the environment (apps/relay/README.md: Limits). The same
//! variables, defaults and refusals as the TypeScript relay's `config.ts`.

use std::fmt::Display;
use std::str::FromStr;

use crate::limits::GateLimits;

#[derive(Clone, Debug)]
pub struct PushConfig {
    /// The push service's full URL, e.g. `https://polaris.lux.dev/api/push`.
    pub url: reqwest::Url,
    pub secret: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub hostname: String,
    /// Read the client's address from the first `X-Forwarded-For` hop.
    pub trust_proxy: bool,
    pub gate: GateLimits,
    pub max_peers: usize,
    pub messages_per_second: u32,
    pub bytes_per_second: u32,
    pub auth_timeout_ms: u64,
    /// Seconds without traffic (pongs count) before a socket is closed.
    pub idle_timeout_seconds: u64,
    /// Bytes queued to a slow receiver before the relay closes it.
    pub backpressure_limit_bytes: usize,
    /// The push service and its shared secret; without both the relay forwards no wakes.
    pub push: Option<PushConfig>,
    pub wakes_per_minute: f64,
    pub wake_burst: f64,
    /// Wakes waiting on the push service at once, across all hosts.
    pub max_wakes_in_flight: usize,
    pub max_live_activities: usize,
    /// How long a host's socket may be gone before its Live Activity slices leave.
    pub live_host_gone_ms: u64,
    /// Threads that serve sockets; one per core, up to eight, when unset.
    pub workers: Option<usize>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 8080,
            hostname: "0.0.0.0".into(),
            trust_proxy: false,
            gate: GateLimits {
                max_connections: 10_000,
                max_connections_per_ip: 32,
                connects_per_second_per_ip: 1.0,
                connect_burst_per_ip: 20.0,
            },
            max_peers: 64,
            messages_per_second: 500,
            bytes_per_second: 8 * 1024 * 1024,
            auth_timeout_ms: 10_000,
            idle_timeout_seconds: 60,
            backpressure_limit_bytes: 16 * 1024 * 1024,
            push: None,
            wakes_per_minute: 60.0,
            wake_burst: 20.0,
            max_wakes_in_flight: 256,
            max_live_activities: 10_000,
            live_host_gone_ms: 120_000,
            workers: None,
        }
    }
}

/// Reads variables; an empty value counts as unset, as it does for the TypeScript relay.
pub struct Env<F: Fn(&str) -> Option<String>>(pub F);

impl<F: Fn(&str) -> Option<String>> Env<F> {
    fn get(&self, name: &str) -> Option<String> {
        (self.0)(name).filter(|value| !value.is_empty())
    }

    fn parsed<T: FromStr>(&self, name: &str, fallback: T) -> Result<T, String>
    where
        T::Err: Display,
    {
        match self.get(name) {
            Some(value) => value.trim().parse().map_err(|error| format!("{name}: {error}")),
            None => Ok(fallback),
        }
    }

    fn boolean(&self, name: &str, fallback: bool) -> Result<bool, String> {
        match self.get(name).as_deref() {
            None => Ok(fallback),
            Some("true" | "yes" | "on" | "1" | "y") => Ok(true),
            Some("false" | "no" | "off" | "0" | "n") => Ok(false),
            Some(other) => Err(format!("{name}: expected a boolean, got {other:?}")),
        }
    }

    /// Both variables or neither: a URL without its secret, or the reverse, is a mistake.
    fn push(&self) -> Result<Option<PushConfig>, String> {
        let url = self.get("POLARIS_RELAY_PUSH_URL");
        let secret = self.get("POLARIS_RELAY_PUSH_SECRET");

        match (url, secret) {
            (None, None) => Ok(None),
            (Some(url), Some(secret)) => {
                let url = reqwest::Url::parse(&url)
                    .map_err(|error| format!("POLARIS_RELAY_PUSH_URL: {error}"))?;

                Ok(Some(PushConfig { url, secret }))
            }
            _ => {
                Err("Set both POLARIS_RELAY_PUSH_URL and POLARIS_RELAY_PUSH_SECRET, or neither"
                    .into())
            }
        }
    }

    pub fn config(&self) -> Result<Config, String> {
        let d = Config::default();

        Ok(Config {
            port: self.parsed("PORT", d.port)?,
            hostname: self.get("POLARIS_RELAY_HOSTNAME").unwrap_or(d.hostname),
            trust_proxy: self.boolean("POLARIS_RELAY_TRUST_PROXY", d.trust_proxy)?,
            gate: GateLimits {
                max_connections: self
                    .parsed("POLARIS_RELAY_MAX_CONNECTIONS", d.gate.max_connections)?,
                max_connections_per_ip: self.parsed(
                    "POLARIS_RELAY_MAX_CONNECTIONS_PER_IP",
                    d.gate.max_connections_per_ip,
                )?,
                connects_per_second_per_ip: f64::from(
                    self.parsed::<u32>("POLARIS_RELAY_CONNECTS_PER_SECOND_PER_IP", 1)?,
                ),
                connect_burst_per_ip: f64::from(
                    self.parsed::<u32>("POLARIS_RELAY_CONNECT_BURST_PER_IP", 20)?,
                ),
            },
            max_peers: self.parsed("POLARIS_RELAY_MAX_PEERS", d.max_peers)?,
            messages_per_second: self
                .parsed("POLARIS_RELAY_MESSAGES_PER_SECOND", d.messages_per_second)?,
            bytes_per_second: self.parsed("POLARIS_RELAY_BYTES_PER_SECOND", d.bytes_per_second)?,
            auth_timeout_ms: self.parsed("POLARIS_RELAY_AUTH_TIMEOUT_MS", d.auth_timeout_ms)?,
            idle_timeout_seconds: self
                .parsed("POLARIS_RELAY_IDLE_TIMEOUT_SECONDS", d.idle_timeout_seconds)?,
            backpressure_limit_bytes: self
                .parsed("POLARIS_RELAY_BACKPRESSURE_LIMIT_BYTES", d.backpressure_limit_bytes)?,
            push: self.push()?,
            wakes_per_minute: f64::from(self.parsed::<u32>("POLARIS_RELAY_WAKES_PER_MINUTE", 60)?),
            wake_burst: f64::from(self.parsed::<u32>("POLARIS_RELAY_WAKE_BURST", 20)?),
            max_wakes_in_flight: self
                .parsed("POLARIS_RELAY_MAX_WAKES_IN_FLIGHT", d.max_wakes_in_flight)?,
            max_live_activities: self
                .parsed("POLARIS_RELAY_MAX_LIVE_ACTIVITIES", d.max_live_activities)?,
            live_host_gone_ms: self
                .parsed("POLARIS_RELAY_LIVE_HOST_GONE_MS", d.live_host_gone_ms)?,
            workers: self.get("POLARIS_RELAY_WORKERS").map(|v| v.parse()).transpose().map_err(
                |error: std::num::ParseIntError| format!("POLARIS_RELAY_WORKERS: {error}"),
            )?,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(pairs: &[(&str, &str)]) -> Result<Config, String> {
        let vars: HashMap<String, String> =
            pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();

        Env(move |name: &str| vars.get(name).cloned()).config()
    }

    #[test]
    fn an_empty_environment_gives_the_documented_defaults() {
        let c = config(&[]).unwrap();

        assert_eq!((c.port, c.hostname.as_str(), c.trust_proxy), (8080, "0.0.0.0", false));
        assert_eq!((c.gate.max_connections, c.gate.max_connections_per_ip), (10_000, 32));
        assert_eq!((c.max_peers, c.messages_per_second, c.bytes_per_second), (64, 500, 8_388_608));
        assert_eq!((c.auth_timeout_ms, c.idle_timeout_seconds), (10_000, 60));
        assert_eq!(c.backpressure_limit_bytes, 16 * 1024 * 1024);
        assert!(c.push.is_none());
    }

    #[test]
    fn variables_override_defaults_and_empty_ones_count_as_unset() {
        let c = config(&[
            ("PORT", "9000"),
            ("POLARIS_RELAY_TRUST_PROXY", "yes"),
            ("POLARIS_RELAY_MAX_PEERS", "4"),
            ("POLARIS_RELAY_HOSTNAME", ""),
        ])
        .unwrap();

        assert_eq!(
            (c.port, c.trust_proxy, c.max_peers, c.hostname.as_str()),
            (9000, true, 4, "0.0.0.0")
        );
    }

    #[test]
    fn a_value_that_is_not_what_its_variable_holds_stops_the_relay() {
        assert!(config(&[("POLARIS_RELAY_MAX_PEERS", "many")]).is_err());
        assert!(config(&[("POLARIS_RELAY_TRUST_PROXY", "maybe")]).is_err());
        assert!(config(&[("PORT", "70000")]).is_err());
    }

    #[test]
    fn the_push_service_needs_both_its_url_and_its_secret() {
        let url = ("POLARIS_RELAY_PUSH_URL", "https://polaris.lux.dev/api/push");
        let secret = ("POLARIS_RELAY_PUSH_SECRET", "s3cret");

        assert!(config(&[url]).unwrap_err().contains("or neither"));
        assert!(config(&[secret]).unwrap_err().contains("or neither"));
        assert!(config(&[("POLARIS_RELAY_PUSH_URL", "not a url"), secret]).is_err());
        let push = config(&[url, secret]).unwrap().push.unwrap();
        assert_eq!((push.url.path(), push.secret.as_str()), ("/api/push", "s3cret"));
    }
}
