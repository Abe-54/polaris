//! The Polaris Relay: the wire contract of README.md, served by tokio.
//! See docs/adr/0104 for why it is shaped as it is.

pub mod config;
pub mod conn;
pub mod events;
pub mod http;
pub mod hub;
pub mod limits;
pub mod live;
pub mod push;
pub mod server;
pub mod session;
pub mod wire;
pub mod ws;
