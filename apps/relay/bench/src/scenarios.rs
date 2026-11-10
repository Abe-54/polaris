//! The scenarios: each starts a fresh relay, drives it, and reports what it measured.

use std::sync::Arc;
use std::time::Duration;

use hdrhistogram::Histogram;
use tokio::sync::Semaphore;

use crate::party::{Failure, Identity, Role, connect, now_ns};
use crate::report::{Better, Metric};
use crate::target::{NO_RATE_LIMITS, Sampled, Sampler, Target, TargetKind};
use crate::traffic::{Flow, Outcome, Run, churn, idle_hosts, pairs};

pub struct Scenario {
    pub name: &'static str,
    pub about: &'static str,
}

pub const SCENARIOS: [Scenario; 8] = [
    Scenario {
        name: "interactive",
        about: "200 pairs, 256 B frames at 20/s each way: the latency of ordinary traffic",
    },
    Scenario {
        name: "stream",
        about: "40 pairs, 16 KiB at 120/s to the device, 64 B at 30/s back: input beside a stream",
    },
    Scenario {
        name: "contend",
        about: "100 pairs at 20/s beside 4 pairs flooding 64 KiB frames: ordinary traffic at saturation",
    },
    Scenario {
        name: "storm",
        about: "100 pairs at 20/s beside 2,000 idle hosts while 300 parties a second connect and leave",
    },
    Scenario {
        name: "flood-small",
        about: "32 pairs, 256 B frames as fast as they arrive: the frame-rate ceiling",
    },
    Scenario {
        name: "flood-large",
        about: "8 pairs, 64 KiB frames as fast as they arrive: the byte-rate ceiling",
    },
    Scenario {
        name: "connect",
        about: "Sockets opened one at a time, then 64 at once: socket open to ready",
    },
    Scenario { name: "idle", about: "2,000 silent pairs: memory per socket and idle CPU" },
];

const MIB: f64 = 1024.0 * 1024.0;

fn micros(histogram: &Histogram<u64>, quantile: f64) -> f64 {
    histogram.value_at_quantile(quantile) as f64 / 1000.0
}

fn latency(prefix: &str, histogram: &Histogram<u64>, quantiles: &[(&str, f64)]) -> Vec<Metric> {
    let mut metrics: Vec<Metric> = quantiles
        .iter()
        .map(|(name, q)| {
            Metric::new(&format!("{prefix}{name}"), micros(histogram, *q), "us", Better::Lower)
        })
        .collect();

    metrics.push(Metric::new(
        &format!("{prefix}max"),
        histogram.max() as f64 / 1000.0,
        "us",
        Better::Lower,
    ));

    metrics
}

const TAIL: [(&str, f64); 4] = [("p50", 0.5), ("p90", 0.9), ("p99", 0.99), ("p99.9", 0.999)];

const BODY: [(&str, f64); 2] = [("p50", 0.5), ("p99", 0.99)];

/// The relay's cost over the window: CPU, CPU per frame it forwarded, and memory.
fn cost(sampled: &Sampled, frames: u64) -> Vec<Metric> {
    let cpu_pct = sampled.cpu_ns as f64 / sampled.wall_ns.max(1) as f64 * 100.0;
    let mut metrics = vec![Metric::new("relay_cpu", cpu_pct, "% of a core", Better::Lower)];

    if frames > 0 {
        let per_frame = sampled.cpu_ns as f64 / frames as f64 / 1000.0;
        metrics.push(Metric::new("relay_cpu_per_frame", per_frame, "us", Better::Lower));
    }

    metrics.push(Metric::new(
        "relay_rss_peak",
        sampled.rss_peak_bytes as f64 / MIB,
        "MiB",
        Better::Lower,
    ));
    metrics.push(Metric::new(
        "relay_footprint_peak",
        sampled.footprint_peak_bytes as f64 / MIB,
        "MiB",
        Better::Lower,
    ));
    metrics.push(Metric::new(
        "loadgen_cpu",
        sampled.own_cpu_ns as f64 / sampled.wall_ns.max(1) as f64 * 100.0,
        "% of a core",
        Better::Info,
    ));

    metrics
}

fn faults(outcome: &Outcome) -> Metric {
    if outcome.faults() > 0 {
        eprintln!(
            "faults: {} out of order, {} unreachable, {} closed early",
            outcome.out_of_order, outcome.unreachable, outcome.closed_early
        );
    }

    Metric::new("faults", outcome.faults() as f64, "frames or sockets", Better::Lower)
}

/// The warm-up asked for on the command line, in place of each scenario's own.
pub static WARM: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();

struct Windows {
    warm: Duration,
    measure: Duration,
}

impl Windows {
    fn of(quick: bool, full_seconds: u64) -> Self {
        Self {
            warm: WARM.get().copied().unwrap_or(Duration::from_secs(if quick { 1 } else { 2 })),
            measure: Duration::from_secs(if quick { 4 } else { full_seconds }),
        }
    }
}

/// Warms up, measures for the window, and stops every socket.
async fn measured(
    target: &Target,
    run: &Arc<Run>,
    sockets: Vec<tokio::task::JoinHandle<()>>,
    windows: &Windows,
) -> (Outcome, Sampled) {
    tokio::time::sleep(windows.warm).await;
    let sampler = Sampler::begin(target);
    run.measure();
    tokio::time::sleep(windows.measure).await;
    let sampled = sampler.end(target).await;

    (run.finish(sockets).await, sampled)
}

fn per_second(count: u64, sampled: &Sampled) -> f64 {
    count as f64 / (sampled.wall_ns.max(1) as f64 / 1e9)
}

async fn interactive(kind: &TargetKind, quick: bool) -> Result<Vec<Metric>, Failure> {
    let target = Target::start(kind, &[]).await?;
    let run = Run::new();
    let flow = Some(Flow::Paced { size: 256, rate: 20.0, class: 0 });
    let sockets = pairs(&target.url, &run, if quick { 50 } else { 200 }, flow, flow).await?;
    let (outcome, sampled) = measured(&target, &run, sockets, &Windows::of(quick, 10)).await;
    let mut metrics = latency("latency_", &outcome.latency[0], &TAIL);
    metrics.push(Metric::new("frames", per_second(outcome.frames(), &sampled), "/s", Better::Info));
    metrics.extend(cost(&sampled, outcome.frames()));
    metrics.push(faults(&outcome));
    target.stop().await?;

    Ok(metrics)
}

async fn stream(kind: &TargetKind, quick: bool) -> Result<Vec<Metric>, Failure> {
    let target = Target::start(kind, &[]).await?;
    let run = Run::new();
    let bulk = Some(Flow::Paced { size: 16 * 1024, rate: 120.0, class: 1 });
    let input = Some(Flow::Paced { size: 64, rate: 30.0, class: 0 });
    let sockets = pairs(&target.url, &run, if quick { 10 } else { 40 }, bulk, input).await?;
    let (outcome, sampled) = measured(&target, &run, sockets, &Windows::of(quick, 10)).await;
    let mut metrics = latency("input_", &outcome.latency[0], &TAIL);
    metrics.extend(latency("bulk_", &outcome.latency[1], &BODY));
    let mib = outcome.bytes as f64 / MIB / (sampled.wall_ns as f64 / 1e9);
    metrics.push(Metric::new("throughput", mib, "MiB/s", Better::Info));
    metrics.extend(cost(&sampled, outcome.frames()));
    metrics.push(faults(&outcome));
    target.stop().await?;

    Ok(metrics)
}

async fn contend(kind: &TargetKind, quick: bool) -> Result<Vec<Metric>, Failure> {
    let target = Target::start(kind, &NO_RATE_LIMITS).await?;
    let run = Run::new();
    let bulk = Some(Flow::Windowed { size: 65_536, window: 16, class: 1 });
    let mut sockets = pairs(&target.url, &run, if quick { 2 } else { 4 }, None, bulk).await?;
    let input = Some(Flow::Paced { size: 256, rate: 20.0, class: 0 });
    sockets.extend(pairs(&target.url, &run, if quick { 30 } else { 100 }, input, input).await?);
    let (outcome, sampled) = measured(&target, &run, sockets, &Windows::of(quick, 10)).await;
    let mut metrics = latency("input_", &outcome.latency[0], &TAIL);
    let mib = outcome.bytes as f64 / MIB / (sampled.wall_ns as f64 / 1e9);
    metrics.push(Metric::new("throughput", mib, "MiB/s", Better::Higher));
    metrics.extend(cost(&sampled, 0));
    metrics.push(faults(&outcome));
    target.stop().await?;

    Ok(metrics)
}

async fn storm(kind: &TargetKind, quick: bool) -> Result<Vec<Metric>, Failure> {
    let target = Target::start(kind, &[]).await?;
    let run = Run::new();
    let mut sockets = idle_hosts(&target.url, &run, if quick { 300 } else { 2000 }, 8).await?;
    let flow = Some(Flow::Paced { size: 256, rate: 20.0, class: 0 });
    sockets.extend(pairs(&target.url, &run, if quick { 30 } else { 100 }, flow, flow).await?);
    let rate = if quick { 100.0 } else { 300.0 };
    let churning = churn(&target.url, &run, rate, Duration::from_millis(300));
    let (outcome, sampled) = measured(&target, &run, sockets, &Windows::of(quick, 10)).await;
    let churned = churning.await?;
    let mut metrics = latency("latency_", &outcome.latency[0], &TAIL);
    metrics.extend(latency("connect_", &churned.connect, &BODY));
    metrics.push(Metric::new(
        "connects",
        per_second(churned.connected, &sampled),
        "/s",
        Better::Info,
    ));
    metrics.push(Metric::new("connects_failed", churned.failed as f64, "sockets", Better::Lower));
    metrics.extend(cost(&sampled, 0));
    metrics.push(faults(&outcome));
    target.stop().await?;

    Ok(metrics)
}

async fn flood(kind: &TargetKind, quick: bool, large: bool) -> Result<Vec<Metric>, Failure> {
    let target = Target::start(kind, &NO_RATE_LIMITS).await?;
    let run = Run::new();

    let (count, flow) = if large {
        (if quick { 4 } else { 8 }, Flow::Windowed { size: 65_536, window: 16, class: 0 })
    } else {
        (if quick { 8 } else { 32 }, Flow::Windowed { size: 256, window: 64, class: 0 })
    };

    let sockets = pairs(&target.url, &run, count, None, Some(flow)).await?;
    let (outcome, sampled) = measured(&target, &run, sockets, &Windows::of(quick, 8)).await;
    let seconds = sampled.wall_ns as f64 / 1e9;

    let mut metrics = vec![
        Metric::new("frames", per_second(outcome.frames(), &sampled), "/s", Better::Higher),
        Metric::new("throughput", outcome.bytes as f64 / MIB / seconds, "MiB/s", Better::Higher),
    ];

    metrics.extend(latency("latency_", &outcome.latency[0], &BODY));
    metrics.extend(cost(&sampled, outcome.frames()));
    metrics.push(faults(&outcome));
    target.stop().await?;

    Ok(metrics)
}

/// Opens a socket, proves a key, and closes; returns nanoseconds from open to ready.
async fn one_connect(url: &str, index: usize) -> Result<u64, Failure> {
    let linked: Vec<String> = (0..8).map(|_| crate::party::random_address()).collect();
    let identity = Identity::generate();
    let began = now_ns();

    let mut ws = if index.is_multiple_of(2) {
        connect(url, Role::Host, &identity, Some(&linked)).await?
    } else {
        connect(url, Role::Device, &identity, None).await?
    };

    let took = now_ns() - began;
    let _ = ws.close(None).await;

    Ok(took)
}

async fn connecting(kind: &TargetKind, quick: bool) -> Result<Vec<Metric>, Failure> {
    let target = Target::start(kind, &[]).await?;
    let mut alone = Histogram::<u64>::new(3)?;

    for index in 0..if quick { 100 } else { 300 } {
        alone.record(one_connect(&target.url, index).await?)?;
    }

    let total = if quick { 500 } else { 3000 };
    let gate = Arc::new(Semaphore::new(64));
    let sampler = Sampler::begin(&target);
    let mut pending = Vec::with_capacity(total);

    for index in 0..total {
        let permit = gate.clone().acquire_owned().await?;
        let url = target.url.clone();

        pending.push(tokio::spawn(async move {
            let took = one_connect(&url, index).await;
            drop(permit);

            took
        }));
    }

    let mut crowded = Histogram::<u64>::new(3)?;

    for connect in pending {
        crowded.record(connect.await??)?;
    }

    let sampled = sampler.end(&target).await;
    let mut metrics = latency("alone_", &alone, &BODY);
    metrics.extend(latency("crowded_", &crowded, &BODY));
    metrics.push(Metric::new("connects", per_second(total as u64, &sampled), "/s", Better::Higher));
    metrics.push(Metric::new(
        "relay_cpu_per_connect",
        sampled.cpu_ns as f64 / total as f64 / 1000.0,
        "us",
        Better::Lower,
    ));
    target.stop().await?;

    Ok(metrics)
}

async fn idle(kind: &TargetKind, quick: bool) -> Result<Vec<Metric>, Failure> {
    let target = Target::start(kind, &[]).await?;
    let empty = target.usage();
    let run = Run::new();
    let count = if quick { 500 } else { 2000 };
    let sockets = pairs(&target.url, &run, count, None, None).await?;
    let windows = Windows { warm: Duration::from_secs(2), ..Windows::of(quick, 10) };
    let (outcome, sampled) = measured(&target, &run, sockets, &windows).await;
    let held = sampled.footprint_peak_bytes.saturating_sub(empty.footprint_bytes) as f64;

    let metrics = vec![
        Metric::new("sockets", (count * 2) as f64, "", Better::Info),
        Metric::new(
            "relay_footprint",
            sampled.footprint_peak_bytes as f64 / MIB,
            "MiB",
            Better::Lower,
        ),
        Metric::new("relay_rss", sampled.rss_peak_bytes as f64 / MIB, "MiB", Better::Lower),
        Metric::new("per_socket", held / (count * 2) as f64 / 1024.0, "KiB", Better::Lower),
        Metric::new(
            "relay_cpu",
            sampled.cpu_ns as f64 / sampled.wall_ns.max(1) as f64 * 100.0,
            "% of a core",
            Better::Lower,
        ),
        faults(&outcome),
    ];

    target.stop().await?;

    Ok(metrics)
}

pub async fn run(name: &str, kind: &TargetKind, quick: bool) -> Result<Vec<Metric>, Failure> {
    match name {
        "interactive" => interactive(kind, quick).await,
        "stream" => stream(kind, quick).await,
        "contend" => contend(kind, quick).await,
        "storm" => storm(kind, quick).await,
        "flood-small" => flood(kind, quick, false).await,
        "flood-large" => flood(kind, quick, true).await,
        "connect" => connecting(kind, quick).await,
        "idle" => idle(kind, quick).await,
        other => Err(format!("unknown scenario {other}").into()),
    }
}
