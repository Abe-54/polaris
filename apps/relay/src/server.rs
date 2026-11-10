//! The relay: what its connections share, the accept loop, and the HTTP a socket speaks
//! before it is a WebSocket. It proves each party's key, forwards data frames between linked
//! parties by their header alone, and holds nothing it forwards beyond the write.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, Weak};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::config::Config;
use crate::conn::{Conn, Ending, Flush, Party};
use crate::events::{Event, Events, unix_ms};
use crate::http;
use crate::hub::Hub;
use crate::limits::{ConnectionGate, Refusal, WakeLimiter};
use crate::live::{Activities, Effect, LIVE_INTERVAL_MS, LiveLimits, LivePut, Update};
use crate::push::{PushClient, PushRequest, live_body, wake_body};
use crate::session::Session;
use crate::wire::{self, Address, MAX_RELAY_MESSAGE_BYTES, RELAY_PATH, Wake, WakeOutcome};

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// How long a request head may take to arrive.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a stopping relay waits for its connections to close.
const STOP_GRACE: Duration = Duration::from_secs(2);

const LISTEN_BACKLOG: i32 = 1024;

/// Plain requests one connection may make before it is closed.
const MAX_PLAIN_REQUESTS: usize = 32;

/// Sockets that may be mid-handshake at once, however small the relay's own limit.
const MIN_HANDSHAKES: usize = 64;

/// When a quiet socket is pinged, and when it is given up on.
#[derive(Clone, Copy, Debug)]
pub struct Idle {
    pub ping: Duration,
    pub drop: Duration,
}

impl Idle {
    /// The ping goes eight seconds before the timeout, or halfway to a short one.
    fn of(seconds: u64) -> Option<Self> {
        let drop = Duration::from_secs(seconds);
        let margin = Duration::from_secs(8).min(drop / 2);

        (seconds > 0).then_some(Self { ping: drop - margin, drop })
    }
}

/// Who is connected: the gate that admitted them, and each open socket, to close on stop.
struct Door {
    gate: ConnectionGate,
    open: HashMap<u64, Arc<Conn>>,
    next: u64,
}

pub struct Relay {
    pub config: Config,
    pub events: Events,
    pub idle: Option<Idle>,
    hub: RwLock<Hub<Party>>,
    door: Mutex<Door>,
    wake_limits: Mutex<WakeLimiter>,
    live: Mutex<Activities>,
    push: Option<PushClient>,
    wakes_in_flight: AtomicUsize,
    /// Sockets accepted and not yet upgraded, which the gate does not count.
    handshakes: AtomicUsize,
    started: Instant,
    /// The challenge after its nonce: the limits and whether wakes are forwarded.
    challenge_rest: String,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Relay {
    /// The relay lives as long as its process, so its connections borrow it freely.
    pub fn new(config: Config, events: Events) -> Result<&'static Self, String> {
        let push = config.push.as_ref().map(PushClient::new).transpose()?;

        let challenge_rest = format!(
            r#""limits":{{"maxMessageBytes":{MAX_RELAY_MESSAGE_BYTES},"maxPeers":{},"messagesPerSecond":{},"bytesPerSecond":{},"authTimeoutMs":{},"idleTimeoutSeconds":{}}},"push":{}}}"#,
            config.max_peers,
            config.messages_per_second,
            config.bytes_per_second,
            config.auth_timeout_ms,
            config.idle_timeout_seconds,
            push.is_some()
        );

        Ok(Box::leak(Box::new(Self {
            idle: Idle::of(config.idle_timeout_seconds),
            hub: RwLock::new(Hub::default()),
            door: Mutex::new(Door {
                gate: ConnectionGate::new(config.gate),
                open: HashMap::new(),
                next: 0,
            }),
            wake_limits: Mutex::new(WakeLimiter::new(config.wakes_per_minute, config.wake_burst)),
            live: Mutex::new(Activities::new(LiveLimits {
                max_activities: config.max_live_activities,
                max_per_host: config.max_peers,
                interval_ms: LIVE_INTERVAL_MS,
                host_gone_ms: config.live_host_gone_ms,
            })),
            push,
            wakes_in_flight: AtomicUsize::new(0),
            handshakes: AtomicUsize::new(0),
            started: Instant::now(),
            challenge_rest,
            config,
            events,
        })))
    }

    /// Milliseconds on the relay's own clock, for its token buckets.
    pub fn now_ms(&self, now: Instant) -> f64 {
        now.duration_since(self.started).as_secs_f64() * 1000.0
    }

    pub fn challenge(&self, nonce: &[u8]) -> String {
        format!(
            r#"{{"t":"challenge","v":1,"nonce":"{}",{}"#,
            wire::to_base64url(nonce),
            self.challenge_rest
        )
    }

    pub fn forwards_wakes(&self) -> bool {
        self.push.is_some()
    }

    /// The hub for routing. Never held across a change to it, nor while taking it again.
    pub fn hub(&self) -> RwLockReadGuard<'_, Hub<Party>> {
        self.hub.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// Changes who is online or linked. What it announces is flushed by the caller's turn.
    pub fn hub_mut<T>(&self, change: impl FnOnce(&mut Hub<Party>) -> T) -> T {
        change(&mut self.hub.write().unwrap_or_else(PoisonError::into_inner))
    }

    pub fn connections(&self) -> usize {
        locked(&self.door).gate.connections()
    }

    fn admit(&self, ip: &str) -> Option<Refusal> {
        locked(&self.door).gate.admit(ip, self.now_ms(Instant::now()))
    }

    fn release(&self, ip: &str) {
        locked(&self.door).gate.release(ip);
    }

    /// Records an admitted socket as open; `leave` undoes it.
    pub fn enter(&self, conn: &Arc<Conn>) -> u64 {
        let mut door = locked(&self.door);
        door.next += 1;
        let id = door.next;
        door.open.insert(id, Arc::clone(conn));

        id
    }

    pub fn leave(&self, id: u64, ip: &str) {
        let mut door = locked(&self.door);
        door.open.remove(&id);
        door.gate.release(ip);
    }

    fn sweep(&self) {
        locked(&self.door).gate.sweep();
        locked(&self.wake_limits).sweep(self.now_ms(Instant::now()));
    }

    fn close_all(&self) {
        let open: Vec<Arc<Conn>> = locked(&self.door).open.values().cloned().collect();

        for conn in open {
            conn.end(Ending::Relay { code: 1001, reason: "shutdown" });
        }
    }

    /// Spends one of `host`'s wakes; false when its budget is empty.
    pub fn take_wake(&self, host: Address) -> bool {
        locked(&self.wake_limits).take(host, self.now_ms(Instant::now()))
    }

    /// Hands one request to the push service, within the cap wakes and updates share.
    async fn deliver(&self, body: String) -> WakeOutcome {
        let Some(push) = &self.push else { return WakeOutcome::Unavailable };

        if self.wakes_in_flight.fetch_add(1, Ordering::AcqRel) >= self.config.max_wakes_in_flight {
            self.wakes_in_flight.fetch_sub(1, Ordering::AcqRel);

            return WakeOutcome::Unavailable;
        }

        let outcome = push.deliver(body, unix_ms()).await;
        self.wakes_in_flight.fetch_sub(1, Ordering::AcqRel);

        outcome
    }

    /// Logs a wake's outcome, then tells the host that asked, if it is still there.
    pub fn answer_wake(&self, conn: &Arc<Conn>, id: &str, outcome: WakeOutcome, started: Instant) {
        self.events.emit(&Event::Wake {
            outcome: outcome.as_str(),
            duration_ms: started.elapsed().as_millis() as u64,
        });

        conn.text(&wire::woken(id, outcome));
    }

    /// Forwards a wake whose ticket checked out, answering when the push service has.
    pub fn deliver_wake(&'static self, conn: Weak<Conn>, wake: Wake, started: Instant) {
        tokio::spawn(async move {
            let request = PushRequest {
                token: &wake.token,
                environment: wake.environment,
                payload: &wake.payload,
            };

            let outcome = self.deliver(wake_body(&request)).await;
            let _flush = Flush;

            match conn.upgrade() {
                Some(conn) => self.answer_wake(&conn, &wake.id, outcome, started),
                None => self.events.emit(&Event::Wake {
                    outcome: outcome.as_str(),
                    duration_ms: started.elapsed().as_millis() as u64,
                }),
            }
        });
    }

    pub fn live_put(&'static self, put: LivePut) {
        let effect = locked(&self.live).put(put, unix_ms());
        self.run_live(effect);
    }

    pub fn live_unlisted(&'static self, host: Address, listed: &[Address]) {
        let effects = locked(&self.live).unlisted(host, listed, unix_ms());

        for effect in effects {
            self.run_live(Some(effect));
        }
    }

    /// A host's last socket closed: its slices leave after the grace unless it returns.
    pub fn live_host_gone(&'static self, host: Address) {
        let effect = locked(&self.live).host_gone(host);
        self.run_live(effect);
    }

    pub fn live_host_back(&self, host: Address) {
        locked(&self.live).host_back(host);
    }

    fn run_live(&'static self, effect: Option<Effect>) {
        match effect {
            Some(Effect::Send(update)) => drop(tokio::spawn(self.send_live(update))),
            Some(Effect::Timer { key, id, timer, wait_ms }) => drop(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                let effect = locked(&self.live).fired(&key, id, timer, unix_ms());
                self.run_live(effect);
            })),
            Some(Effect::Away { host, timer, wait_ms }) => drop(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                let effects = locked(&self.live).stayed_gone(host, timer, unix_ms());

                for effect in effects {
                    self.run_live(Some(effect));
                }
            })),
            None => {}
        }
    }

    async fn send_live(&'static self, update: Update) {
        let Update { key, id, timestamp, slices, alert, hosts } = update;
        let body = live_body(&key.token, key.environment, timestamp, &slices, alert);
        let outcome = self.deliver(body).await;
        self.events.emit(&Event::Live { outcome: outcome.as_str(), hosts, alert });
        let gone = locked(&self.live).delivered(&key, id, outcome);
        let Some(hosts) = gone else { return };
        let _flush = Flush;
        let hub = self.hub();

        // APNs no longer knows the token: every host in the activity stops sending to it.
        for host in hosts {
            if let Some(party) = hub.host(&host) {
                party.conn.text(&wire::live_gone(&key.token, "unregistered"));
            }
        }
    }
}

fn bind(hostname: &str, port: u16) -> io::Result<std::net::TcpListener> {
    let address = (hostname, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no address to listen on"))?;

    let socket = Socket::new(Domain::for_address(address), Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&address.into())?;
    socket.listen(LISTEN_BACKLOG)?;

    Ok(socket.into())
}

pub struct Listening {
    relay: &'static Relay,
    listener: std::net::TcpListener,
    pub port: u16,
}

/// Binds the relay's port and says so; `serve` then takes connections.
pub fn listen(relay: &'static Relay) -> io::Result<Listening> {
    let listener = bind(&relay.config.hostname, relay.config.port)?;
    let port = listener.local_addr()?.port();
    relay.events.emit(&Event::Start { port });

    Ok(Listening { relay, listener, port })
}

/// A socket handed to another thread, and the token that says its connection still runs.
type Handed = (std::net::TcpStream, IpAddr, mpsc::Sender<()>);

/// Where accepted sockets are served: here, or on threads that each run their own loop. A
/// connection stays on its thread, and writes to any other socket from there (ADR 0104).
enum Workers {
    Here,
    Threads { queues: Vec<mpsc::UnboundedSender<Handed>>, next: usize },
}

impl Workers {
    fn start(relay: &'static Relay, count: usize) -> io::Result<Self> {
        if count <= 1 {
            return Ok(Workers::Here);
        }

        let queues = (0..count).map(|index| worker(relay, index)).collect::<io::Result<_>>()?;

        Ok(Workers::Threads { queues, next: 0 })
    }

    fn take(
        &mut self,
        relay: &'static Relay,
        stream: TcpStream,
        peer: IpAddr,
        alive: mpsc::Sender<()>,
    ) {
        match self {
            Workers::Here => drop(tokio::spawn(connection(relay, stream, peer, alive))),
            Workers::Threads { queues, next } => {
                *next = (*next + 1) % queues.len();

                // A worker lives as long as the process, so its queue is never closed.
                if let Ok(stream) = stream.into_std() {
                    let _ = queues[*next].send((stream, peer, alive));
                }
            }
        }
    }
}

/// Starts a thread that serves the sockets sent to it, on its own single-threaded loop.
fn worker(relay: &'static Relay, index: usize) -> io::Result<mpsc::UnboundedSender<Handed>> {
    let (queue, mut handed) = mpsc::unbounded_channel::<Handed>();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;

    std::thread::Builder::new().name(format!("relay-{index}")).spawn(move || {
        runtime.block_on(async move {
            while let Some((stream, peer, alive)) = handed.recv().await {
                if let Ok(stream) = TcpStream::from_std(stream) {
                    tokio::spawn(connection(relay, stream, peer, alive));
                }
            }
        });
    })?;

    Ok(queue)
}

impl Listening {
    /// Serves until `stop` resolves, then closes every socket and waits for them to go.
    pub async fn serve(self, stop: impl Future<Output = ()>) -> io::Result<()> {
        let Self { relay, listener, .. } = self;
        let listener = TcpListener::from_std(listener)?;
        let mut workers = Workers::start(relay, relay.config.workers.unwrap_or_else(cores))?;
        let (alive, mut all_gone) = mpsc::channel::<()>(1);

        let sweep = tokio::spawn(async move {
            let mut every = tokio::time::interval(SWEEP_INTERVAL);

            loop {
                every.tick().await;
                relay.sweep();
            }
        });

        tokio::pin!(stop);

        loop {
            tokio::select! {
                () = &mut stop => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, peer)) => workers.take(relay, stream, peer.ip(), alive.clone()),
                    // Out of descriptors, most likely: let some close before trying again.
                    Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                },
            }
        }

        sweep.abort();
        drop(listener);
        drop(alive);
        relay.close_all();
        // Resolves once every connection is done, each holding a sender until then.
        let _ = tokio::time::timeout(STOP_GRACE, all_gone.recv()).await;

        Ok(())
    }
}

/// The threads a relay serves on when none is set: one per core, up to eight.
fn cores() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from).min(8)
}

async fn connection(
    relay: &'static Relay,
    mut stream: TcpStream,
    peer: IpAddr,
    alive: mpsc::Sender<()>,
) {
    // Frames are written whole and should leave at once.
    let _ = stream.set_nodelay(true);

    let upgraded = match Handshake::begin(relay) {
        Some(_counted) => upgrade(relay, &mut stream, peer).await,
        None => {
            relay.events.emit(&Event::Refused { reason: Refusal::RelayFull.as_str() });

            None
        }
    };

    if let Some(upgrade) = upgraded {
        Session::new(relay, stream, upgrade).run().await;
    }

    drop(alive);
}

/// A socket between accept and upgrade, counted until this is dropped.
struct Handshake(&'static Relay);

impl Handshake {
    /// None when as many sockets are mid-handshake as the relay may hold connected.
    fn begin(relay: &'static Relay) -> Option<Self> {
        let room = relay.config.gate.max_connections.max(MIN_HANDSHAKES);

        if relay.handshakes.fetch_add(1, Ordering::AcqRel) >= room {
            relay.handshakes.fetch_sub(1, Ordering::AcqRel);

            return None;
        }

        Some(Self(relay))
    }
}

impl Drop for Handshake {
    fn drop(&mut self) {
        self.0.handshakes.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A socket the relay agreed to make a WebSocket.
pub struct Upgrade {
    /// The client's network address, which the gate counts it under. Never logged.
    pub ip: String,
    /// The reply to the upgrade request, still to be written.
    pub reply: Vec<u8>,
    /// Bytes the client sent after its request: the start of its first frame.
    pub early: Vec<u8>,
}

enum Answer {
    Upgrade { ip: String, accept: String },
    Reply { status: u16, body: &'static str },
}

fn answer(relay: &Relay, head: &http::Head, peer: IpAddr) -> Answer {
    if head.path == "/healthz" {
        return Answer::Reply { status: 200, body: "ok" };
    }

    if head.path != RELAY_PATH {
        return Answer::Reply { status: 404, body: "Not found" };
    }

    let forwarded = head.forwarded_for.clone().filter(|_| relay.config.trust_proxy);
    let ip = forwarded.unwrap_or_else(|| peer.to_string());

    if let Some(refusal) = relay.admit(&ip) {
        relay.events.emit(&Event::Refused { reason: refusal.as_str() });

        return Answer::Reply { status: refusal.status(), body: refusal.as_str() };
    }

    match &head.accept {
        Some(accept) => Answer::Upgrade { ip, accept: accept.clone() },
        None => {
            relay.release(&ip);

            Answer::Reply { status: 426, body: "Expected a WebSocket upgrade" }
        }
    }
}

/// Reads one request head into `buf`, which may already hold the start of it.
async fn read_head(stream: &mut TcpStream, buf: &mut Vec<u8>) -> Result<http::Head, Option<u16>> {
    loop {
        match http::parse(buf) {
            http::Parsed::Head(head) => return Ok(head),
            http::Parsed::Invalid => return Err(Some(400)),
            http::Parsed::Incomplete if buf.len() > http::MAX_HEAD_BYTES => return Err(Some(431)),
            http::Parsed::Incomplete => {}
        }

        match stream.read_buf(buf).await {
            Ok(0) | Err(_) => return Err(None),
            Ok(_) => {}
        }
    }
}

/// Answers plain requests until one is a WebSocket upgrade the gate admits.
async fn upgrade(relay: &'static Relay, stream: &mut TcpStream, peer: IpAddr) -> Option<Upgrade> {
    let mut buf = Vec::with_capacity(1024);
    let mut answered = 0;

    loop {
        let head = match tokio::time::timeout(HEAD_TIMEOUT, read_head(stream, &mut buf)).await {
            Ok(Ok(head)) => head,
            Ok(Err(Some(status))) => {
                let _ = stream.write_all(&http::response(status, "Bad request", false)).await;

                return None;
            }
            Ok(Err(None)) | Err(_) => return None,
        };

        match answer(relay, &head, peer) {
            Answer::Upgrade { ip, accept } => {
                let early = buf.split_off(head.len);

                return Some(Upgrade { ip, reply: http::switching(&accept), early });
            }
            Answer::Reply { status, body } => {
                answered += 1;
                let keep = head.keep_alive && answered < MAX_PLAIN_REQUESTS;
                let reply = http::response(status, body, keep);

                if stream.write_all(&reply).await.is_err() || !keep {
                    return None;
                }

                buf.drain(..head.len);
            }
        }
    }
}
