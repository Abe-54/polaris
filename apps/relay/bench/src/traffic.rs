//! Linked pairs exchanging stamped frames through the relay, and what arrived.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use hdrhistogram::Histogram;
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::party::{Failure, Identity, Role, Ws, connect, now_ns, read_stamp, stamped_frame};

/// Frame classes a scenario tells apart, e.g. input and bulk.
pub const CLASSES: usize = 2;

const SHARDS: usize = 16;

/// How one side of a pair sends.
#[derive(Clone, Copy)]
pub enum Flow {
    /// `rate` frames a second on a timer, whatever comes back.
    Paced { size: usize, rate: f64, class: u8 },
    /// As fast as the peer receives, with at most `window` frames on their way.
    Windowed { size: usize, window: u64, class: u8 },
}

/// Shared by every socket of a run.
pub struct Run {
    measuring: AtomicBool,
    /// Latencies in nanoseconds per class, sharded so readers rarely share a lock.
    latency: Vec<Vec<Mutex<Histogram<u64>>>>,
    received: [AtomicU64; CLASSES],
    bytes: AtomicU64,
    out_of_order: AtomicU64,
    unreachable: AtomicU64,
    closed_early: AtomicU64,
    stop: watch::Sender<bool>,
}

/// What a run measured between `measure` and `finish`.
pub struct Outcome {
    pub latency: Vec<Histogram<u64>>,
    pub received: [u64; CLASSES],
    pub bytes: u64,
    pub out_of_order: u64,
    pub unreachable: u64,
    pub closed_early: u64,
}

impl Outcome {
    pub fn frames(&self) -> u64 {
        self.received.iter().sum()
    }

    /// Frames lost, reordered, refused, or sockets the relay closed: all must be zero.
    pub fn faults(&self) -> u64 {
        self.out_of_order + self.unreachable + self.closed_early
    }
}

fn histogram() -> Histogram<u64> {
    Histogram::new(3).expect("3 significant figures is a valid precision")
}

impl Run {
    pub fn new() -> Arc<Self> {
        let shards = || (0..SHARDS).map(|_| Mutex::new(histogram())).collect();

        Arc::new(Self {
            measuring: AtomicBool::new(false),
            latency: (0..CLASSES).map(|_| shards()).collect(),
            received: Default::default(),
            bytes: AtomicU64::new(0),
            out_of_order: AtomicU64::new(0),
            unreachable: AtomicU64::new(0),
            closed_early: AtomicU64::new(0),
            stop: watch::channel(false).0,
        })
    }

    /// Starts counting: everything before this was warm-up.
    pub fn measure(&self) {
        self.measuring.store(true, Ordering::Release);
    }

    fn measuring(&self) -> bool {
        self.measuring.load(Ordering::Acquire)
    }

    fn stopping(&self) -> bool {
        *self.stop.borrow()
    }

    /// Stops every socket and returns what was measured.
    pub async fn finish(self: &Arc<Self>, sockets: Vec<JoinHandle<()>>) -> Outcome {
        self.measuring.store(false, Ordering::Release);
        self.stop.send_replace(true);

        for socket in sockets {
            let _ = socket.await;
        }

        let merged = |class: &Vec<Mutex<Histogram<u64>>>| {
            let mut all = histogram();

            for shard in class {
                let _ = all.add(&*shard.lock().expect("no reader panics holding a shard"));
            }

            all
        };

        let count = |counters: &[AtomicU64; CLASSES]| {
            std::array::from_fn(|class| counters[class].load(Ordering::Relaxed))
        };

        Outcome {
            latency: self.latency.iter().map(merged).collect(),
            received: count(&self.received),
            bytes: self.bytes.load(Ordering::Relaxed),
            out_of_order: self.out_of_order.load(Ordering::Relaxed),
            unreachable: self.unreachable.load(Ordering::Relaxed),
            closed_early: self.closed_early.load(Ordering::Relaxed),
        }
    }
}

/// Frames a windowed sender's peer has received, and the wake-up for the sender.
#[derive(Default)]
struct Arrivals {
    count: AtomicU64,
    changed: Notify,
}

async fn read(mut stream: SplitStream<Ws>, run: Arc<Run>, shard: usize, arrivals: Arc<Arrivals>) {
    let mut stop = run.stop.subscribe();
    let mut next_seq = [None::<u32>; CLASSES];

    loop {
        let message = tokio::select! {
            message = stream.next() => message,
            _ = stop.changed() => return,
        };

        let received_ns = now_ns();

        match message {
            Some(Ok(Message::Binary(frame))) => {
                let Some(stamp) = read_stamp(&frame) else { continue };
                let class = usize::from(stamp.class).min(CLASSES - 1);

                if next_seq[class].is_some_and(|expected| expected != stamp.seq) {
                    run.out_of_order.fetch_add(1, Ordering::Relaxed);
                }

                next_seq[class] = Some(stamp.seq.wrapping_add(1));
                arrivals.count.fetch_add(1, Ordering::Release);
                arrivals.changed.notify_one();

                if run.measuring() {
                    run.received[class].fetch_add(1, Ordering::Relaxed);
                    run.bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);
                    let latency = received_ns.saturating_sub(stamp.sent_ns).max(1);
                    let mut shard = run.latency[class][shard % SHARDS]
                        .lock()
                        .expect("no reader panics holding a shard");
                    let _ = shard.record(latency);
                }
            }
            Some(Ok(Message::Text(text))) => {
                // Once the run stops, a peer that hung up first is no fault of the relay's.
                if text.as_str().contains("\"unreachable\"") && !run.stopping() {
                    run.unreachable.fetch_add(1, Ordering::Relaxed);
                }
            }
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                if !run.stopping() {
                    run.closed_early.fetch_add(1, Ordering::Relaxed);
                }

                return;
            }
            Some(Ok(_)) => {}
        }
    }
}

async fn send_paced(
    mut sink: SplitSink<Ws, Message>,
    run: Arc<Run>,
    peer: String,
    (size, rate, class): (usize, f64, u8),
) {
    let mut stop = run.stop.subscribe();
    let period = Duration::from_secs_f64(1.0 / rate);
    // A random phase, so the sockets of a run don't all send on the same tick.
    let phase = period.mul_f64(rand::random::<f64>());
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + phase, period);
    let mut seq = 0u32;

    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = stop.changed() => break,
        }

        if sink.send(Message::Binary(stamped_frame(&peer, size, class, seq))).await.is_err() {
            break;
        }

        seq = seq.wrapping_add(1);
    }

    let _ = sink.close().await;
}

async fn send_windowed(
    mut sink: SplitSink<Ws, Message>,
    run: Arc<Run>,
    peer: String,
    (size, window, class): (usize, u64, u8),
    arrivals: Arc<Arrivals>,
) {
    let mut stop = run.stop.subscribe();
    let mut sent = 0u64;

    while !run.stopping() {
        if sent - arrivals.count.load(Ordering::Acquire) >= window {
            tokio::select! {
                _ = arrivals.changed.notified() => {}
                _ = stop.changed() => break,
            }

            continue;
        }

        let frame = stamped_frame(&peer, size, class, sent as u32);

        if sink.send(Message::Binary(frame)).await.is_err() {
            break;
        }

        sent += 1;
    }

    let _ = sink.close().await;
}

/// Holds a socket open without sending until the run stops.
async fn hold(mut sink: SplitSink<Ws, Message>, run: Arc<Run>) {
    let mut stop = run.stop.subscribe();

    if !run.stopping() {
        let _ = stop.changed().await;
    }

    let _ = sink.close().await;
}

/// One socket's reader and sender. `outbound` counts what this socket's peer received
/// from it; `inbound` counts what this socket received.
fn drive(
    ws: Ws,
    run: &Arc<Run>,
    shard: usize,
    peer: String,
    flow: Option<Flow>,
    inbound: Arc<Arrivals>,
    outbound: Arc<Arrivals>,
) -> JoinHandle<()> {
    let (sink, stream) = ws.split();
    let reader = tokio::spawn(read(stream, run.clone(), shard, inbound));
    let run = run.clone();

    tokio::spawn(async move {
        match flow {
            Some(Flow::Paced { size, rate, class }) => {
                send_paced(sink, run, peer, (size, rate, class)).await
            }
            Some(Flow::Windowed { size, window, class }) => {
                send_windowed(sink, run, peer, (size, window, class), outbound).await
            }
            None => hold(sink, run).await,
        }

        let _ = reader.await;
    })
}

/// Connects `count` host and device pairs, each host linking its device, and starts their
/// flows. Returns once every socket is ready.
pub async fn pairs(
    url: &str,
    run: &Arc<Run>,
    count: usize,
    host_flow: Option<Flow>,
    device_flow: Option<Flow>,
) -> Result<Vec<JoinHandle<()>>, Failure> {
    let mut sockets = Vec::with_capacity(count * 2);
    let mut pending = Vec::new();

    for index in 0..count {
        let url = url.to_owned();

        pending.push(tokio::spawn(async move {
            let host = Identity::generate();
            let device = Identity::generate();
            let linked = [device.address.clone()];
            let host_ws = connect(&url, Role::Host, &host, Some(&linked)).await?;
            let device_ws = connect(&url, Role::Device, &device, None).await?;

            Ok::<_, Failure>((index, host, host_ws, device, device_ws))
        }));

        // Bounded, so a relay isn't measured against a connect storm it didn't ask for.
        if pending.len() == 64 || index + 1 == count {
            for connected in pending.drain(..) {
                let (index, host, host_ws, device, device_ws) = connected.await??;
                let to_host = Arc::new(Arrivals::default());
                let to_device = Arc::new(Arrivals::default());

                sockets.push(drive(
                    host_ws,
                    run,
                    index * 2,
                    device.address.clone(),
                    host_flow,
                    to_host.clone(),
                    to_device.clone(),
                ));
                sockets.push(drive(
                    device_ws,
                    run,
                    index * 2 + 1,
                    host.address,
                    device_flow,
                    to_device,
                    to_host,
                ));
            }
        }
    }

    Ok(sockets)
}

impl Run {
    /// Resolves when the run stops.
    pub fn stopped(&self) -> watch::Receiver<bool> {
        self.stop.subscribe()
    }
}

/// Connects `count` hosts that each list `peers` devices nobody is, and holds them silent.
pub async fn idle_hosts(
    url: &str,
    run: &Arc<Run>,
    count: usize,
    peers: usize,
) -> Result<Vec<JoinHandle<()>>, Failure> {
    let mut sockets = Vec::with_capacity(count);
    let mut pending = Vec::new();

    for index in 0..count {
        let url = url.to_owned();

        pending.push(tokio::spawn(async move {
            let linked: Vec<String> = (0..peers).map(|_| crate::party::random_address()).collect();

            connect(&url, Role::Host, &Identity::generate(), Some(&linked)).await
        }));

        if pending.len() == 64 || index + 1 == count {
            for connected in pending.drain(..) {
                let (sink, stream) = connected.await??.split();
                let reader = tokio::spawn(read(stream, run.clone(), 0, Arc::default()));
                let run = run.clone();

                sockets.push(tokio::spawn(async move {
                    hold(sink, run).await;
                    let _ = reader.await;
                }));
            }
        }
    }

    Ok(sockets)
}

/// What a churn of connecting and leaving parties did.
pub struct Churned {
    pub connected: u64,
    pub failed: u64,
    /// Socket open to `ready`, in nanoseconds.
    pub connect: Histogram<u64>,
}

/// Parties that connect at `rate` a second, stay `stay`, and leave, until the run stops:
/// what a relay sees when every party reconnects after a deploy.
pub fn churn(url: &str, run: &Arc<Run>, rate: f64, stay: Duration) -> JoinHandle<Churned> {
    let url = url.to_owned();
    let run = run.clone();

    tokio::spawn(async move {
        let connected = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicU64::new(0));
        let times = Arc::new(Mutex::new(histogram()));
        let mut stop = run.stopped();
        let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / rate));
        let mut index = 0u64;

        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = stop.changed() => break,
            }

            index += 1;
            let (url, run) = (url.clone(), run.clone());
            let (connected, failed, times) = (connected.clone(), failed.clone(), times.clone());

            tokio::spawn(async move {
                let linked: Vec<String> = (0..8).map(|_| crate::party::random_address()).collect();
                let host = index.is_multiple_of(2);
                let began = now_ns();

                let result = if host {
                    connect(&url, Role::Host, &Identity::generate(), Some(&linked)).await
                } else {
                    connect(&url, Role::Device, &Identity::generate(), None).await
                };

                let Ok(mut ws) = result else {
                    failed.fetch_add(1, Ordering::Relaxed);
                    return;
                };

                if run.measuring() {
                    connected.fetch_add(1, Ordering::Relaxed);
                    let _ = times
                        .lock()
                        .expect("no churner panics holding the histogram")
                        .record((now_ns() - began).max(1));
                }

                tokio::time::sleep(stay).await;
                let _ = ws.close(None).await;
            });
        }

        Churned {
            connected: connected.load(Ordering::Relaxed),
            failed: failed.load(Ordering::Relaxed),
            connect: times.lock().expect("no churner panics holding the histogram").clone(),
        }
    })
}
