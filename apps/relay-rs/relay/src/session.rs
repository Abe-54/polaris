//! One connection's life: the challenge, the proof of its key, frames in, and its end.
//! Reading is synchronous between waits: a turn reads what the socket has, forwards it,
//! and flushes every socket it wrote to before the task waits again (docs/adr/0104).

use std::cell::RefCell;
use std::io::ErrorKind;
use std::net::Shutdown;
use std::sync::{Arc, RwLockReadGuard};
use std::time::Duration;

use socket2::SockRef;
use tokio::net::TcpStream;
use tokio::time::{Instant, sleep_until, timeout_at};

use crate::conn::{Conn, Ending, Flush, Party};
use crate::events::Event;
use crate::hub::Hub;
use crate::limits::TokenBucket;
use crate::live::LivePut;
use crate::server::{Relay, Upgrade};
use crate::wire::{
    self, Address, Auth, ClientControl, HEADER_BYTES, Live, MAX_RELAY_MESSAGE_BYTES, NONCE_BYTES,
    Role, Wake, WakeOutcome, close,
};
use crate::ws;

/// The buffer a turn reads into: room for a few of the largest frames.
const SCRATCH_BYTES: usize = 256 * 1024;

/// Bytes one turn reads before the thread's other connections run: about one large frame,
/// so ordinary traffic waits one frame per busy connection when bulk fills the core.
const TURN_BYTES: usize = 64 * 1024;

/// How long a closed socket is given to read its close frame and hang up.
const LINGER: Duration = Duration::from_secs(2);

const PROTOCOL_ERROR: Ending =
    Ending::Relay { code: ws::CLOSE_PROTOCOL_ERROR, reason: "protocol-error" };
const TOO_BIG: Ending = Ending::Relay { code: ws::CLOSE_TOO_BIG, reason: "too-big" };
const AUTH_FAILED: Ending = Ending::Relay { code: close::AUTH_FAILED, reason: "auth-failed" };
const AUTH_TIMEOUT: Ending = Ending::Relay { code: close::AUTH_TIMEOUT, reason: "auth-timeout" };
const RATE_LIMITED: Ending = Ending::Relay { code: close::RATE_LIMITED, reason: "rate-limited" };

thread_local! {
    /// One per thread: a turn never waits while it holds it, so connections share it.
    static SCRATCH: RefCell<Vec<u8>> = RefCell::new(vec![0; SCRATCH_BYTES]);
}

/// What a turn of reading came to.
enum Step {
    /// The socket has nothing more for now.
    Wait,
    /// The turn's budget is spent; others go first.
    Yield,
    End(Ending),
}

enum Read {
    Again,
    Blocked,
    Spent,
    End(Ending),
}

/// What one turn holds while it runs: the hub for routing, taken at its first data frame.
struct Turn {
    hub: Option<RwLockReadGuard<'static, Hub<Party>>>,
    now_ms: f64,
    budget: usize,
}

#[derive(Default)]
struct Counts {
    frames_in: u64,
    bytes_in: u64,
    control_in: u64,
    unreachable: u64,
    wakes: u64,
}

pub struct Session {
    relay: &'static Relay,
    conn: Arc<Conn>,
    /// The connection's key in the relay's list of open sockets.
    id: u64,
    ip: String,
    opened: Instant,
    auth_deadline: Instant,
    nonce: [u8; NONCE_BYTES],
    messages: TokenBucket,
    bytes: TokenBucket,
    /// Set once the party proved its key.
    party: Option<Arc<Party>>,
    /// An incomplete frame, kept between turns.
    partial: Option<Partial>,
    /// A fragmented message so far, and whether it is text.
    fragments: Option<(bool, Vec<u8>)>,
    last_heard: Instant,
    pinged: bool,
    want_write: bool,
    counts: Counts,
}

/// An incomplete frame: `buf` has room for all of it, and `len` bytes of it are here.
struct Partial {
    buf: Vec<u8>,
    len: usize,
}

impl Partial {
    /// Keeps `rest`, the start of a frame, in a buffer sized for the whole frame.
    fn of(rest: &[u8]) -> Option<Self> {
        if rest.is_empty() {
            return None;
        }

        let mut buf = vec![0; needed(rest).max(rest.len())];
        buf[..rest.len()].copy_from_slice(rest);

        Some(Self { buf, len: rest.len() })
    }
}

/// The bytes the frame starting `bytes` takes in all, or enough to read its header.
fn needed(bytes: &[u8]) -> usize {
    match ws::parse_head(bytes, MAX_RELAY_MESSAGE_BYTES) {
        ws::Parsed::Head(head) => head.head_len + head.payload_len,
        _ => ws::MAX_HEAD_BYTES,
    }
}

impl Session {
    pub fn new(relay: &'static Relay, stream: TcpStream, upgrade: Upgrade) -> Self {
        let now = Instant::now();
        let now_ms = relay.now_ms(now);
        let config = &relay.config;
        let conn = Conn::new(stream, config.backpressure_limit_bytes, upgrade.reply);
        let messages = f64::from(config.messages_per_second);
        let bytes = f64::from(config.bytes_per_second);

        Self {
            relay,
            id: relay.enter(&conn),
            conn,
            ip: upgrade.ip,
            opened: now,
            auth_deadline: now + Duration::from_millis(config.auth_timeout_ms),
            nonce: rand::random(),
            messages: TokenBucket::new(messages, messages * 2.0, now_ms),
            bytes: TokenBucket::new(bytes, bytes * 2.0, now_ms),
            party: None,
            partial: Partial::of(&upgrade.early),
            fragments: None,
            last_heard: now,
            pinged: false,
            want_write: false,
            counts: Counts::default(),
        }
    }

    pub async fn run(mut self) {
        let ending = self.serve().await;
        self.finish(ending).await;
    }

    async fn serve(&mut self) -> Ending {
        let conn = Arc::clone(&self.conn);

        if let Some(ending) = self.open() {
            return ending;
        }

        let timer = sleep_until(self.deadline());
        let woken = conn.wake().notified();
        tokio::pin!(timer, woken);

        loop {
            tokio::select! {
                biased;
                () = &mut woken => {
                    woken.set(conn.wake().notified());
                    let (asked, blocked) = conn.status();

                    if let Some(ending) = asked {
                        return ending;
                    }

                    self.want_write |= blocked;
                }
                ready = conn.stream().writable(), if self.want_write => {
                    match ready.map_err(|_| Ending::GONE).and_then(|()| conn.flush_owned()) {
                        Ok(written) => self.want_write = !written,
                        Err(ending) => return ending,
                    }
                }
                ready = conn.stream().readable() => {
                    if ready.is_err() {
                        return Ending::GONE;
                    }

                    match self.turn() {
                        Step::Wait => {}
                        Step::Yield => tokio::task::yield_now().await,
                        Step::End(ending) => return ending,
                    }
                }
                () = &mut timer => {
                    if let Some(ending) = self.on_timer(Instant::now()) {
                        return ending;
                    }

                    timer.as_mut().reset(self.deadline());
                }
            }
        }
    }

    /// Sends the challenge with the upgrade's reply, then takes what came with the request.
    fn open(&mut self) -> Option<Ending> {
        let _flush = Flush;
        self.conn.text(&self.relay.challenge(&self.nonce));

        let early = self.partial.take()?;
        let mut turn = self.begin(Instant::now());

        self.resume(early, &mut turn).err()
    }

    /// Acts on the whole frames in `partial` and keeps what is left of it.
    fn resume(&mut self, mut partial: Partial, turn: &mut Turn) -> Result<(), Ending> {
        let taken = self.frames(&mut partial.buf[..partial.len], turn)?;

        // Nothing whole yet: the same buffer goes on filling.
        self.partial =
            if taken == 0 { Some(partial) } else { Partial::of(&partial.buf[taken..partial.len]) };

        Ok(())
    }

    fn begin(&self, now: Instant) -> Turn {
        Turn { hub: None, now_ms: self.relay.now_ms(now), budget: TURN_BYTES }
    }

    /// When the timer next has something to decide.
    fn deadline(&self) -> Instant {
        let auth = self.party.is_none().then_some(self.auth_deadline);

        let idle = self
            .relay
            .idle
            .map(|idle| self.last_heard + if self.pinged { idle.drop } else { idle.ping });

        match (auth, idle) {
            (Some(auth), Some(idle)) => auth.min(idle),
            (Some(only), None) | (None, Some(only)) => only,
            (None, None) => Instant::now() + Duration::from_secs(24 * 60 * 60),
        }
    }

    fn on_timer(&mut self, now: Instant) -> Option<Ending> {
        if self.party.is_none() && now >= self.auth_deadline {
            return Some(AUTH_TIMEOUT);
        }

        let idle = self.relay.idle?;
        let quiet = now.duration_since(self.last_heard);

        if quiet >= idle.drop {
            return Some(Ending::Dropped { by: "idle" });
        }

        if quiet >= idle.ping && !self.pinged {
            let _flush = Flush;
            self.pinged = true;
            self.conn.ping();
        }

        None
    }

    fn heard(&mut self, now: Instant) {
        self.last_heard = now;
        self.pinged = false;
    }

    /// Reads what the socket has and acts on every whole frame in it.
    fn turn(&mut self) -> Step {
        // Declared first, so it flushes last: after the turn has let go of the hub.
        let _flush = Flush;
        let now = Instant::now();

        // A socket kept busy without a proof still meets its deadline.
        if self.party.is_none() && now >= self.auth_deadline {
            return Step::End(AUTH_TIMEOUT);
        }

        let mut turn = self.begin(now);

        loop {
            let read = match self.partial.take() {
                Some(partial) => self.read_partial(partial, &mut turn, now),
                None => {
                    SCRATCH.with_borrow_mut(|scratch| self.read_scratch(scratch, &mut turn, now))
                }
            };

            match read {
                Read::Again => {}
                Read::Blocked => return Step::Wait,
                Read::Spent => return Step::Yield,
                Read::End(ending) => return Step::End(ending),
            }
        }
    }

    /// Reads into the thread's buffer and acts on frames where they lie. A frame cut short
    /// is finished in place while it fits; otherwise its start is kept for the next turn.
    fn read_scratch(&mut self, scratch: &mut [u8], turn: &mut Turn, now: Instant) -> Read {
        let (mut start, mut end) = (0, 0);

        loop {
            // A turn reads its budget, then no further than the end of the frame it is in.
            let wanted = if turn.budget == 0 {
                start + needed(&scratch[start..end])
            } else {
                end + turn.budget
            };

            let room = wanted.min(scratch.len());

            let drained = match self.conn.read(&mut scratch[end..room]) {
                Ok((0, _)) => return Read::End(Ending::GONE),
                Ok((count, drained)) => {
                    end += count;
                    turn.budget = turn.budget.saturating_sub(count);
                    self.heard(now);

                    drained
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    self.partial = Partial::of(&scratch[start..end]);

                    return Read::Blocked;
                }
                Err(_) => return Read::End(Ending::GONE),
            };

            match self.frames(&mut scratch[start..end], turn) {
                Ok(taken) => start += taken,
                Err(ending) => return Read::End(ending),
            }

            let spent = turn.budget == 0;

            if start == end {
                (start, end) = (0, 0);
            }

            // A frame cut short is finished here only while the buffer has room for it.
            let full = start < end && start + needed(&scratch[start..end]) > scratch.len();

            if drained || full || (spent && start == end) {
                self.partial = Partial::of(&scratch[start..end]);

                return if drained {
                    Read::Blocked
                } else if spent {
                    Read::Spent
                } else {
                    Read::Again
                };
            }
        }
    }

    /// Reads more of the frame kept from an earlier turn, into its own buffer.
    fn read_partial(&mut self, mut partial: Partial, turn: &mut Turn, now: Instant) -> Read {
        let need = needed(&partial.buf[..partial.len]);

        if partial.buf.len() < need {
            partial.buf.resize(need, 0);
        }

        let drained = match self.conn.read(&mut partial.buf[partial.len..]) {
            Ok((0, _)) => return Read::End(Ending::GONE),
            Ok((count, drained)) => {
                partial.len += count;
                turn.budget = turn.budget.saturating_sub(count);
                self.heard(now);

                drained
            }
            Err(error) => {
                self.partial = Some(partial);

                return match error.kind() {
                    ErrorKind::Interrupted => Read::Again,
                    ErrorKind::WouldBlock => Read::Blocked,
                    _ => Read::End(Ending::GONE),
                };
            }
        };

        match self.resume(partial, turn) {
            Err(ending) => Read::End(ending),
            Ok(()) if drained => Read::Blocked,
            Ok(()) if turn.budget == 0 => Read::Spent,
            Ok(()) => Read::Again,
        }
    }

    /// Acts on every whole frame at the start of `bytes`; returns how many bytes they took.
    fn frames(&mut self, bytes: &mut [u8], turn: &mut Turn) -> Result<usize, Ending> {
        let mut at = 0;

        loop {
            let head = match ws::parse_head(&bytes[at..], MAX_RELAY_MESSAGE_BYTES) {
                ws::Parsed::Head(head) => head,
                ws::Parsed::Incomplete => return Ok(at),
                ws::Parsed::Invalid => return Err(PROTOCOL_ERROR),
                ws::Parsed::TooBig => return Err(TOO_BIG),
            };

            let end = at + head.head_len + head.payload_len;

            if end > bytes.len() {
                return Ok(at);
            }

            self.still_open()?;
            let payload = &mut bytes[at + head.head_len..end];
            ws::unmask(payload, head.mask);
            self.frame(head, payload, turn)?;
            at = end;
        }
    }

    /// Fails once another task ended this connection: nothing more from it is acted on.
    fn still_open(&self) -> Result<(), Ending> {
        if !self.conn.is_closed() {
            return Ok(());
        }

        Err(self.conn.status().0.unwrap_or(Ending::GONE))
    }

    fn frame(&mut self, head: ws::Head, payload: &mut [u8], turn: &mut Turn) -> Result<(), Ending> {
        match head.opcode {
            ws::OP_TEXT | ws::OP_BINARY if self.fragments.is_some() => Err(PROTOCOL_ERROR),
            ws::OP_TEXT | ws::OP_BINARY if head.fin => {
                self.message(head.opcode == ws::OP_TEXT, payload, turn)
            }
            ws::OP_TEXT | ws::OP_BINARY => {
                self.fragments = Some((head.opcode == ws::OP_TEXT, payload.to_vec()));

                Ok(())
            }
            ws::OP_CONTINUATION => self.continuation(head.fin, payload, turn),
            ws::OP_PING => {
                self.conn.pong(payload);

                Ok(())
            }
            ws::OP_CLOSE => Err(Ending::Peer { code: ws::close_code(payload) }),
            _ => Ok(()),
        }
    }

    fn continuation(&mut self, fin: bool, payload: &[u8], turn: &mut Turn) -> Result<(), Ending> {
        let Some((text, mut whole)) = self.fragments.take() else { return Err(PROTOCOL_ERROR) };

        if whole.len() + payload.len() > MAX_RELAY_MESSAGE_BYTES {
            return Err(TOO_BIG);
        }

        whole.extend_from_slice(payload);

        if !fin {
            self.fragments = Some((text, whole));

            return Ok(());
        }

        self.message(text, &mut whole, turn)
    }

    /// One whole message: counted against the sender's rates, then control or data.
    fn message(&mut self, text: bool, payload: &mut [u8], turn: &mut Turn) -> Result<(), Ending> {
        let size = payload.len();
        self.counts.bytes_in += size as u64;

        if !self.messages.take(1.0, turn.now_ms) || !self.bytes.take(size as f64, turn.now_ms) {
            return Err(RATE_LIMITED);
        }

        if text { self.control(payload, turn) } else { self.data(payload, turn) }
    }

    /// Forwards one data frame. Source and destination addresses are the same length, so
    /// the sender's is written over the destination and the bytes go on from where they lie.
    fn data(&mut self, payload: &mut [u8], turn: &mut Turn) -> Result<(), Ending> {
        let Some(party) = &self.party else { return Err(Ending::bad("data-before-ready")) };
        let Some(peer) = wire::forward_peer(payload) else { return Err(Ending::bad("bad-frame")) };
        self.counts.frames_in += 1;
        let relay = self.relay;
        let hub = turn.hub.get_or_insert_with(|| relay.hub());

        // Under the hub, a newer connection of this key can no longer replace this one.
        if self.conn.is_closed() {
            return Err(self.conn.status().0.unwrap_or(Ending::GONE));
        }

        match hub.route(party.address, party.role, &peer) {
            Some(target) => {
                payload[3..HEADER_BYTES].copy_from_slice(party.address.as_bytes());
                target.conn.forward(payload);
            }
            None => {
                self.counts.unreachable += 1;
                self.conn.text(&wire::unreachable(&peer));
            }
        }

        Ok(())
    }

    fn control(&mut self, text: &[u8], turn: &mut Turn) -> Result<(), Ending> {
        self.counts.control_in += 1;
        // A control message may change the hub, which this turn must not be holding.
        turn.hub = None;

        match wire::decode_client_control(text) {
            Some(ClientControl::Auth(auth)) => self.authenticate(auth),
            Some(ClientControl::Peers { peers }) => self.peers(&peers),
            Some(ClientControl::Wake(wake)) => self.wake(wake),
            Some(ClientControl::Live(live)) => self.live(live),
            None => Err(Ending::bad("bad-control")),
        }
    }

    /// The key a valid proof was made with: only a host may list peers as it proves it.
    fn proven(&self, auth: &Auth) -> Option<Vec<u8>> {
        let key = wire::from_base64url(&auth.key)?;
        let signature = wire::from_base64url(&auth.sig)?;
        let allowed = auth.role == Role::Host || auth.peers.is_none();
        let message = wire::auth_message(&self.nonce, auth.role);

        (allowed && wire::verify_ed25519(&key, &message, &signature)).then_some(key)
    }

    fn authenticate(&mut self, auth: Auth) -> Result<(), Ending> {
        if self.party.is_some() {
            return Err(Ending::bad("auth-twice"));
        }

        let Some(key) = self.proven(&auth) else { return Err(AUTH_FAILED) };
        let peers = auth.peers.unwrap_or_default();

        if peers.len() > self.relay.config.max_peers {
            return Err(Ending::bad("too-many-peers"));
        }

        let address = Address::of_key(&key);
        let party = Arc::new(Party { address, role: auth.role, conn: Arc::clone(&self.conn) });
        self.conn.text(&wire::ready(&address));
        self.relay.hub_mut(|hub| hub.attach(Arc::clone(&party), &peers));

        if auth.role == Role::Host {
            self.relay.live_host_back(address);
        }

        self.party = Some(party);

        Ok(())
    }

    /// This connection's party, when it is a host; otherwise the reason it may not ask.
    fn host(&self, refusal: &'static str) -> Result<Arc<Party>, Ending> {
        match &self.party {
            Some(party) if party.role == Role::Host => Ok(Arc::clone(party)),
            _ => Err(Ending::bad(refusal)),
        }
    }

    fn peers(&mut self, peers: &[Address]) -> Result<(), Ending> {
        let host = self.host("peers-not-host")?;

        if peers.len() > self.relay.config.max_peers {
            return Err(Ending::bad("too-many-peers"));
        }

        self.relay.hub_mut(|hub| hub.set_peers(&host, peers));
        self.relay.live_unlisted(host.address, peers);

        Ok(())
    }

    /// Forwards a host's wake when the device's ticket lets this host wake it at that
    /// token, online or not. Never logs what it carries.
    fn wake(&mut self, wake: Wake) -> Result<(), Ending> {
        let host = self.host("wake-not-host")?;
        let started = Instant::now();
        self.counts.wakes += 1;
        let Wake { ticket, peer, environment, token, .. } = &wake;

        let refused = if !self.relay.take_wake(host.address) {
            Some(WakeOutcome::RateLimited)
        } else if !wire::verify_push_ticket(ticket, peer, &host.address, *environment, token) {
            Some(WakeOutcome::Unlinked)
        } else {
            None
        };

        match refused {
            Some(outcome) => self.relay.answer_wake(&self.conn, &wake.id, outcome, started),
            None => self.relay.deliver_wake(Arc::downgrade(&self.conn), wake, started),
        }

        Ok(())
    }

    /// Keeps a host's slice of a device's Live Activity when the device's live ticket lets
    /// this host update it. An alert spends the host's wake budget, or goes as routine.
    fn live(&mut self, frame: Live) -> Result<(), Ending> {
        let host = self.host("live-not-host")?;
        let Live { ticket, peer, environment, token, slice, active, alert } = frame;

        if !wire::verify_live_ticket(&ticket, &peer, &host.address, environment, &token) {
            self.conn.text(&wire::live_gone(&token, "unlinked"));

            return Ok(());
        }

        if !self.relay.forwards_wakes() {
            return Ok(());
        }

        let alert = alert && slice.is_some() && self.relay.take_wake(host.address);
        self.relay.live_put(LivePut {
            host: host.address,
            peer,
            token,
            environment,
            slice,
            active,
            alert,
        });

        Ok(())
    }

    /// Takes the connection out of the relay, logs it, then closes the socket.
    async fn finish(self, ending: Ending) {
        let sent = self.conn.seal();

        if let Some(party) = &self.party {
            let _flush = Flush;

            let last = self.relay.hub_mut(|hub| {
                hub.detach(party);

                party.role == Role::Host && hub.host(&party.address).is_none()
            });

            // A socket that was replaced leaves its host online, so nothing starts.
            if last {
                self.relay.live_host_gone(party.address);
            }
        }

        self.relay.leave(self.id, &self.ip);

        self.relay.events.emit(&Event::Connection {
            conn: wire::to_base64url(&rand::random::<[u8; 9]>()),
            role: self.party.as_ref().map(|party| party.role.as_str()),
            authenticated: self.party.is_some(),
            duration_ms: self.opened.elapsed().as_millis() as u64,
            frames_in: self.counts.frames_in,
            bytes_in: self.counts.bytes_in,
            frames_out: sent.frames,
            bytes_out: sent.bytes,
            control_in: self.counts.control_in,
            unreachable: self.counts.unreachable,
            dropped: sent.dropped,
            wakes: self.counts.wakes,
            close_code: ending.close_code(),
            ended_by: ending.ended_by(),
        });

        match ending {
            Ending::Relay { code, reason } => self.close(code, reason).await,
            Ending::Peer { code } => self.close(code, "").await,
            Ending::Dropped { .. } => {}
        }

        let _ = SockRef::from(self.conn.stream()).shutdown(Shutdown::Both);
    }

    /// Sends the close frame after what is queued, then reads until the peer hangs up, so
    /// the frame isn't lost to a reset.
    async fn close(&self, code: u16, reason: &str) {
        let deadline = Instant::now() + LINGER;
        let stream = self.conn.stream();
        self.conn.close_frame(code, reason);

        loop {
            match self.conn.flush_owned() {
                Ok(true) => break,
                Ok(false) if timeout_at(deadline, stream.writable()).await.is_ok() => {}
                _ => return,
            }
        }

        let _ = SockRef::from(stream).shutdown(Shutdown::Write);

        while let Ok(Ok(())) = timeout_at(deadline, stream.readable()).await {
            let read = SCRATCH.with_borrow_mut(|scratch| stream.try_read(scratch));

            match read {
                Ok(0) => return,
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(_) => return,
            }
        }
    }
}
