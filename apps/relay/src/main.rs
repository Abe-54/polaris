//! The Polaris Relay process: reads its config, serves until SIGTERM, then closes every socket.

use std::process::ExitCode;

use polaris_relay::config::{Config, Env};
use polaris_relay::events::Events;
use polaris_relay::server::{Relay, listen};

/// Resolves at SIGTERM, which is how a container platform stops the relay, or at SIGINT.
#[cfg(unix)]
async fn stopped() {
    use tokio::signal::unix::{SignalKind, signal};

    let (Ok(mut terminate), Ok(mut interrupt)) =
        (signal(SignalKind::terminate()), signal(SignalKind::interrupt()))
    else {
        return std::future::pending().await;
    };

    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
}

/// Resolves at Ctrl-C. Windows has no SIGTERM: the tests that run there end the process.
#[cfg(not(unix))]
async fn stopped() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

async fn serve(config: Config) -> Result<(), String> {
    let relay = Relay::new(config, Events::stdout())?;
    let listening = listen(relay).map_err(|error| format!("listen: {error}"))?;

    listening.serve(stopped()).await.map_err(|error| format!("serve: {error}"))
}

fn run() -> Result<(), String> {
    let config = Env(|name: &str| std::env::var(name).ok()).config()?;
    // The push client speaks TLS with ring; installing it twice is the only way this fails.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();

    runtime.map_err(|error| format!("runtime: {error}"))?.block_on(serve(config))
}

fn main() -> ExitCode {
    match run() {
        // A clean stop exits 0.
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");

            ExitCode::FAILURE
        }
    }
}
