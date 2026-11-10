//! Starts the relay under test as its own process and samples it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use crate::party::Failure;
use crate::proc::{Usage, usage};

/// Which relay to start.
#[derive(Clone, Debug)]
pub enum TargetKind {
    /// This workspace's release binary.
    Relay,
    /// Any command that serves the relay on `PORT`, such as another build of it.
    Command(Vec<String>),
}

impl TargetKind {
    pub fn parse(text: &str) -> Self {
        match text {
            "relay" => TargetKind::Relay,
            other => TargetKind::Command(other.split_whitespace().map(str::to_owned).collect()),
        }
    }

    fn command(&self) -> Vec<String> {
        match self {
            TargetKind::Relay => {
                vec![workspace().join("target/release/polaris-relay").display().to_string()]
            }
            TargetKind::Command(words) => words.clone(),
        }
    }
}

/// The relay's workspace: this crate lives in its `bench` directory.
pub fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap_or_default()
}

/// Per-address limits a load generator on one machine would hit at once.
const OPEN_GATE: [(&str, &str); 4] = [
    ("POLARIS_RELAY_MAX_CONNECTIONS", "200000"),
    ("POLARIS_RELAY_MAX_CONNECTIONS_PER_IP", "200000"),
    ("POLARIS_RELAY_CONNECTS_PER_SECOND_PER_IP", "200000"),
    ("POLARIS_RELAY_CONNECT_BURST_PER_IP", "200000"),
];

/// Message and byte rates out of the way, for scenarios that measure the ceiling.
pub const NO_RATE_LIMITS: [(&str, &str); 2] = [
    ("POLARIS_RELAY_MESSAGES_PER_SECOND", "100000000"),
    ("POLARIS_RELAY_BYTES_PER_SECOND", "1000000000"),
];

fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// A running relay process.
pub struct Target {
    pub url: String,
    pid: i32,
    child: Child,
}

impl Target {
    /// Starts the relay on a free loopback port and waits for its `relay.start` line.
    pub async fn start(kind: &TargetKind, env: &[(&str, &str)]) -> Result<Self, Failure> {
        let words = kind.command();
        let port = free_port()?;
        let (program, args) = words.split_first().ok_or("empty relay command")?;

        let mut child = Command::new(program)
            .args(args)
            .env("PORT", port.to_string())
            .env("POLARIS_RELAY_HOSTNAME", "127.0.0.1")
            .envs(OPEN_GATE)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("could not start `{}`: {error}", words.join(" ")))?;

        let stdout = child.stdout.take().ok_or("the relay has no stdout")?;
        let (started, wait) = oneshot::channel();

        // Keeps reading after the start line, so the relay's log never fills the pipe.
        tokio::spawn(async move {
            let mut started = Some(started);
            let mut lines = BufReader::new(stdout).lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if line.contains("\"relay.start\"")
                    && let Some(started) = started.take()
                {
                    let _ = started.send(());
                }
            }
        });

        tokio::time::timeout(Duration::from_secs(20), wait)
            .await
            .map_err(|_| "the relay never logged relay.start")?
            .map_err(|_| "the relay exited before it started")?;

        let pid = child.id().ok_or("the relay has no pid")? as i32;

        if std::env::var_os("RELAY_BENCH_VERBOSE").is_some() {
            eprintln!("relay pid {pid}");
        }

        Ok(Self { url: format!("ws://127.0.0.1:{port}/v1"), pid, child })
    }

    pub fn usage(&self) -> Usage {
        usage(self.pid).unwrap_or_default()
    }

    /// Stops the relay with SIGTERM, as a container platform does; errors unless it exits 0.
    pub async fn stop(mut self) -> Result<(), Failure> {
        // SAFETY: kill takes no pointers; the pid is our own child's.
        unsafe { libc::kill(self.pid, libc::SIGTERM) };

        let status = tokio::time::timeout(Duration::from_secs(15), self.child.wait())
            .await
            .map_err(|_| "the relay did not exit on SIGTERM")??;

        if status.success() { Ok(()) } else { Err(format!("the relay exited {status}").into()) }
    }
}

fn own_usage() -> Usage {
    usage(std::process::id() as i32).unwrap_or_default()
}

/// Samples a relay over a window: CPU time spent and the largest memory seen.
pub struct Sampler {
    start: Usage,
    own_start: Usage,
    stop: oneshot::Sender<()>,
    peak: tokio::task::JoinHandle<(u64, u64)>,
    began: std::time::Instant,
}

/// What a relay used over a window.
pub struct Sampled {
    pub cpu_ns: u64,
    /// CPU the load generator itself spent: near its thread count, it was the limit.
    pub own_cpu_ns: u64,
    pub wall_ns: u64,
    pub rss_peak_bytes: u64,
    pub footprint_peak_bytes: u64,
}

impl Sampler {
    pub fn begin(target: &Target) -> Self {
        let pid = target.pid;
        let (stop, mut stopped) = oneshot::channel();

        let peak = tokio::spawn(async move {
            let mut peak = (0, 0);
            let mut tick = tokio::time::interval(Duration::from_millis(100));

            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let now = usage(pid).unwrap_or_default();
                        peak = (peak.0.max(now.rss_bytes), peak.1.max(now.footprint_bytes));
                    }
                    _ = &mut stopped => return peak,
                }
            }
        });

        Self {
            start: target.usage(),
            own_start: own_usage(),
            stop,
            peak,
            began: std::time::Instant::now(),
        }
    }

    pub async fn end(self, target: &Target) -> Sampled {
        let wall_ns = self.began.elapsed().as_nanos() as u64;
        let end = target.usage();
        let _ = self.stop.send(());
        let (rss, footprint) = self.peak.await.unwrap_or_default();

        Sampled {
            cpu_ns: end.cpu_ns.saturating_sub(self.start.cpu_ns),
            own_cpu_ns: own_usage().cpu_ns.saturating_sub(self.own_start.cpu_ns),
            wall_ns,
            rss_peak_bytes: rss.max(end.rss_bytes),
            footprint_peak_bytes: footprint.max(end.footprint_bytes),
        }
    }
}
