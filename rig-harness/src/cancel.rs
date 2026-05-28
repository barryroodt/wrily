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
