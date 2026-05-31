use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Spawn a timeout watchdog that cancels the supplied token after `timeout_ms`.
/// Returns the JoinHandle so callers can abort the watchdog on clean shutdown.
pub fn spawn_timeout_watchdog(
    token: CancellationToken,
    timeout_ms: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                token.cancel();
            }
            _ = token.cancelled() => {
                // Already cancelled by meter or other path — nothing to do.
            }
        }
    })
}

/// Build a shared CancellationToken used by TokenMeter + timeout + agent loop.
pub fn shared_token() -> CancellationToken {
    CancellationToken::new()
}

/// Spawn a handler that cancels `token` on SIGTERM (and SIGINT). The run loop
/// observes the cancellation and, when the budget meter has not tripped, exits
/// as a timeout (`result{exit:"timeout"}`, code 3) per the spec's shutdown
/// contract. Returns the JoinHandle so callers can drop it on clean shutdown.
#[cfg(unix)]
pub fn spawn_signal_handler(token: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut intr = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(_) => return,
        };
        tokio::select! {
            _ = term.recv() => token.cancel(),
            _ = intr.recv() => token.cancel(),
            _ = token.cancelled() => {}
        }
    })
}

/// Non-unix fallback: no signal handling; the watchdog still bounds the run.
#[cfg(not(unix))]
pub fn spawn_signal_handler(token: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _ = token;
    })
}
