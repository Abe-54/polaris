//! One party's socket as every task sees it. The task that owns a connection reads it;
//! any task may queue output for it, and whoever queued flushes, so a forwarded frame is
//! written by its sender's task with no hand-off (docs/adr/0104).

use std::cell::RefCell;
use std::io::{self, ErrorKind, IoSlice, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use socket2::{SockRef, Socket};
use tokio::io::Interest;
use tokio::net::TcpStream;
use tokio::sync::Notify;

use crate::hub::Endpoint;
use crate::wire::{Address, Role, close};
use crate::ws;

/// A frame this large gains nothing from sharing a write, so it is written at once.
pub const DIRECT_BYTES: usize = 8 * 1024;

/// An emptied output buffer larger than this is freed, so a quiet socket holds little.
const KEEP_BYTES: usize = 16 * 1024;

/// How a connection ends, as its wide event and its peer see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    /// The relay closes it with this code and reason.
    Relay { code: u16, reason: &'static str },
    /// The peer sent a close frame carrying this code.
    Peer { code: u16 },
    /// It goes without a close frame, which a peer reads as 1006.
    Dropped { by: &'static str },
}

impl Ending {
    pub const fn bad(reason: &'static str) -> Self {
        Ending::Relay { code: close::BAD_MESSAGE, reason }
    }

    pub const GONE: Self = Ending::Dropped { by: "peer" };

    pub fn close_code(self) -> u16 {
        match self {
            Ending::Relay { code, .. } | Ending::Peer { code } => code,
            Ending::Dropped { .. } => ws::CLOSE_ABNORMAL,
        }
    }

    pub fn ended_by(self) -> &'static str {
        match self {
            Ending::Relay { reason, .. } => reason,
            Ending::Peer { .. } => "peer",
            Ending::Dropped { by } => by,
        }
    }
}

/// What a connection was sent, for its wide event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Sent {
    pub frames: u64,
    pub bytes: u64,
    pub dropped: u64,
}

struct Out {
    /// Whole frames waiting for the socket; `start` is how much of it is already written.
    buf: Vec<u8>,
    start: usize,
    /// Whether other tasks may still queue output.
    open: bool,
    /// The socket took less than was queued; the owner is waiting for it to take more.
    blocked: bool,
    asked: Option<Ending>,
    sent: Sent,
}

impl Out {
    fn pending(&self) -> usize {
        self.buf.len() - self.start
    }

    fn emptied(&mut self) {
        self.start = 0;

        if self.buf.capacity() > KEEP_BYTES {
            self.buf = Vec::new();
        } else {
            self.buf.clear();
        }
    }

    /// Drops what is already written once it is most of the buffer.
    fn compact(&mut self) {
        if self.start > KEEP_BYTES && self.start > self.buf.len() / 2 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wrote {
    All,
    Some,
    Failed,
}

pub struct Conn {
    stream: TcpStream,
    out: Mutex<Out>,
    /// Wakes the owner: output is blocked, or the connection was asked to end.
    wake: Notify,
    /// Set once the connection takes no more output; read without the lock.
    closed: AtomicBool,
    /// Bytes queued to a slow receiver before the relay gives up on it.
    limit: usize,
}

thread_local! {
    /// Connections this thread queued output for and has yet to flush.
    static TOUCHED: RefCell<Vec<Arc<Conn>>> = const { RefCell::new(Vec::new()) };
}

/// Flushes every connection this thread queued output for.
pub fn flush_touched() {
    let mut touched = TOUCHED.take();

    for conn in touched.drain(..) {
        conn.flush();
    }

    // Hands the emptied list back, so the next turn doesn't allocate one.
    TOUCHED.with_borrow_mut(|slot| {
        if slot.is_empty() {
            *slot = touched;
        }
    });
}

/// Flushes what this thread queued when it goes, so no way out of a section forgets to.
pub struct Flush;

impl Drop for Flush {
    fn drop(&mut self) {
        flush_touched();
    }
}

impl Conn {
    /// `first` goes out before anything else: the reply to the upgrade request.
    pub fn new(stream: TcpStream, limit: usize, first: Vec<u8>) -> Arc<Self> {
        Arc::new(Self {
            stream,
            out: Mutex::new(Out {
                buf: first,
                start: 0,
                open: true,
                blocked: false,
                asked: None,
                sent: Sent::default(),
            }),
            wake: Notify::new(),
            closed: AtomicBool::new(false),
            limit,
        })
    }

    pub fn stream(&self) -> &TcpStream {
        &self.stream
    }

    /// Reads once. The flag says the read came up short, which empties the socket: the wait
    /// for more then starts without a second read that would only find it empty.
    pub fn read(&self, buf: &mut [u8]) -> io::Result<(usize, bool)> {
        let socket = SockRef::from(&self.stream);
        let mut reader: &Socket = &socket;
        let mut count = None;

        // Reporting a short read as not ready is how the stream forgets it was readable.
        let outcome = self.stream.try_io(Interest::READABLE, || {
            let read = reader.read(buf)?;
            count = Some(read);

            if read > 0 && read < buf.len() { Err(ErrorKind::WouldBlock.into()) } else { Ok(()) }
        });

        match (count, outcome) {
            (Some(read), outcome) => Ok((read, outcome.is_err())),
            (None, outcome) => outcome.map(|()| (0, false)),
        }
    }

    /// The pending wake-up for the owner, which it keeps across turns.
    pub fn wake(&self) -> &Notify {
        &self.wake
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn lock(&self) -> MutexGuard<'_, Out> {
        self.out.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Why the connection was asked to end, and whether its output waits on the socket.
    pub fn status(&self) -> (Option<Ending>, bool) {
        let out = self.lock();

        (out.asked, out.blocked)
    }

    /// Asks the owner to end the connection. The first reason asked is the one it ends with.
    pub fn end(&self, ending: Ending) {
        self.ask(&mut self.lock(), ending);
    }

    fn ask(&self, out: &mut Out, ending: Ending) {
        out.asked.get_or_insert(ending);
        out.open = false;
        self.closed.store(true, Ordering::Release);
        self.wake.notify_one();
    }

    /// Stops other tasks queueing output: the owner is closing. Returns what was sent.
    pub fn seal(&self) -> Sent {
        let mut out = self.lock();
        out.open = false;
        self.closed.store(true, Ordering::Release);

        out.sent
    }

    /// Queues a whole frame; this thread flushes it when its turn ends.
    fn queue(self: &Arc<Self>, opcode: u8, payload: &[u8]) {
        let mut out = self.lock();

        if !out.open {
            out.sent.dropped += 1;

            return;
        }

        self.push(&mut out, opcode, payload);
        drop(out);
        touch(self);
    }

    fn push(&self, out: &mut Out, opcode: u8, payload: &[u8]) {
        out.compact();
        ws::push_frame(&mut out.buf, opcode, payload);

        if out.pending() > self.limit {
            self.ask(out, Ending::Dropped { by: "backpressure" });
        }
    }

    /// Queues a control message, after every frame already queued.
    pub fn text(self: &Arc<Self>, message: &str) {
        self.queue(ws::OP_TEXT, message.as_bytes());
    }

    pub fn pong(self: &Arc<Self>, payload: &[u8]) {
        self.queue(ws::OP_PONG, payload);
    }

    pub fn ping(self: &Arc<Self>) {
        self.queue(ws::OP_PING, &[]);
    }

    /// Queues the close frame once the connection is sealed; nothing follows it.
    pub fn close_frame(&self, code: u16, reason: &str) {
        let mut out = self.lock();

        if code == ws::CLOSE_NO_STATUS {
            ws::push_frame(&mut out.buf, ws::OP_CLOSE, &[]);
        } else {
            ws::push_close(&mut out.buf, code, reason);
        }
    }

    /// Forwards one data frame: a small one shares this turn's write, a large one is
    /// written straight from the sender's buffer when nothing is queued ahead of it.
    pub fn forward(self: &Arc<Self>, payload: &[u8]) {
        let mut out = self.lock();

        if !out.open {
            out.sent.dropped += 1;

            return;
        }

        out.sent.frames += 1;
        out.sent.bytes += payload.len() as u64;

        if out.blocked {
            self.push(&mut out, ws::OP_BINARY, payload);
        } else if payload.len() < DIRECT_BYTES {
            self.push(&mut out, ws::OP_BINARY, payload);
            drop(out);
            touch(self);
        } else {
            self.direct(&mut out, payload);
        }
    }

    fn direct(&self, out: &mut Out, payload: &[u8]) {
        match self.write(out) {
            Wrote::All => {}
            Wrote::Some => {
                self.block(out);

                return self.push(out, ws::OP_BINARY, payload);
            }
            Wrote::Failed => return,
        }

        let mut head = [0u8; ws::MAX_SERVER_HEAD_BYTES];
        let head_len = ws::write_head(ws::OP_BINARY, payload.len(), &mut head);
        let head = &head[..head_len];
        let mut written = 0;

        while written < head_len + payload.len() {
            let result = if written < head_len {
                let parts = [IoSlice::new(&head[written..]), IoSlice::new(payload)];
                self.stream.try_write_vectored(&parts)
            } else {
                self.stream.try_write(&payload[written - head_len..])
            };

            match result {
                Ok(0) => return self.ask(out, Ending::GONE),
                Ok(count) => written += count,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    // The socket is full: the rest of this frame waits its turn in the buffer.
                    out.buf.extend_from_slice(&head[written.min(head_len)..]);
                    out.buf.extend_from_slice(&payload[written.saturating_sub(head_len)..]);
                    self.block(out);

                    if out.pending() > self.limit {
                        self.ask(out, Ending::Dropped { by: "backpressure" });
                    }

                    return;
                }
                Err(_) => return self.ask(out, Ending::GONE),
            }
        }
    }

    fn block(&self, out: &mut Out) {
        out.blocked = true;
        self.wake.notify_one();
    }

    /// Writes what is queued, as far as the socket takes it.
    fn write(&self, out: &mut Out) -> Wrote {
        while out.pending() > 0 {
            match self.stream.try_write(&out.buf[out.start..]) {
                Ok(0) => return self.failed(out),
                Ok(count) => out.start += count,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => return Wrote::Some,
                Err(_) => return self.failed(out),
            }
        }

        out.emptied();

        Wrote::All
    }

    fn failed(&self, out: &mut Out) -> Wrote {
        out.buf = Vec::new();
        out.start = 0;
        self.ask(out, Ending::GONE);

        Wrote::Failed
    }

    /// Writes what is queued. When the socket takes less, the owner is woken to wait for it.
    pub fn flush(&self) {
        let mut out = self.lock();

        if !out.blocked && self.write(&mut out) == Wrote::Some {
            self.block(&mut out);
        }
    }

    /// The owner's flush once the socket can take more: whether everything is written.
    pub fn flush_owned(&self) -> Result<bool, Ending> {
        let mut out = self.lock();

        match self.write(&mut out) {
            Wrote::All => {
                out.blocked = false;

                Ok(true)
            }
            Wrote::Some => {
                out.blocked = true;

                Ok(false)
            }
            Wrote::Failed => Err(Ending::GONE),
        }
    }
}

/// Marks `conn` as holding output this thread queued and has yet to flush.
fn touch(conn: &Arc<Conn>) {
    TOUCHED.with_borrow_mut(|touched| {
        if !touched.iter().any(|other| Arc::ptr_eq(other, conn)) {
            touched.push(Arc::clone(conn));
        }
    });
}

/// A party that proved its key: what the hub routes to.
pub struct Party {
    pub address: Address,
    pub role: Role,
    pub conn: Arc<Conn>,
}

impl Endpoint for Party {
    fn address(&self) -> Address {
        self.address
    }

    fn role(&self) -> Role {
        self.role
    }

    fn send(&self, message: &str) {
        self.conn.text(message);
    }

    fn replace(&self) {
        self.conn.end(Ending::Relay { code: close::REPLACED, reason: "replaced" });
    }
}
