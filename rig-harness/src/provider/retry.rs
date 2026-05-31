//! Provider retry policy (spec §"Error handling").
//!
//! - **429 (rate limited):** retry once, honoring `Retry-After` when the value
//!   is available (only the Cursor adapter, which owns its HTTP layer, can
//!   surface it — it embeds `retry-after=<secs>` in the error message).
//! - **5xx / network / timeout (transient):** exponential backoff 3× (1s/4s/16s).
//! - **4xx and everything else (fatal):** return immediately.
//!
//! The rig-based adapters (Anthropic/OpenAI/Gemini) do not expose raw HTTP
//! status codes, so classification falls back to matching the error text. This
//! is best-effort by necessity; the Cursor adapter (default eval provider) owns
//! its reqwest layer and classifies precisely.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use super::ProviderResponse;

/// Boxed provider call future, re-created per attempt so each retry rebuilds its
/// request without requiring the request type to be `Clone`.
pub type ProviderFuture<'a> =
    Pin<Box<dyn Future<Output = anyhow::Result<ProviderResponse>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorClass {
    RateLimited { retry_after: Option<Duration> },
    Transient,
    Fatal,
}

#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Number of retries for a 429 response.
    pub rate_limit_retries: u32,
    /// Default wait before a rate-limit retry when no `Retry-After` is known.
    pub rate_limit_delay: Duration,
    /// Backoff schedule for transient (5xx/network) errors; length = max retries.
    pub transient_backoffs: Vec<Duration>,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            rate_limit_retries: 1,
            rate_limit_delay: Duration::from_secs(1),
            transient_backoffs: vec![
                Duration::from_secs(1),
                Duration::from_secs(4),
                Duration::from_secs(16),
            ],
        }
    }
}

/// Heuristic error classification by message text (see module docs for why).
pub fn classify_error(err: &anyhow::Error) -> ErrorClass {
    let msg = format!("{err:#}").to_lowercase();

    if msg.contains("429") || msg.contains("rate limit") || msg.contains("too many requests") {
        return ErrorClass::RateLimited {
            retry_after: parse_retry_after(&msg),
        };
    }

    let transient_markers = [
        "500",
        "502",
        "503",
        "504",
        "timeout",
        "timed out",
        "connection",
        "connect error",
        "network",
        "temporarily",
        "reset by peer",
        "broken pipe",
        "eof",
    ];
    if transient_markers.iter().any(|m| msg.contains(m)) {
        return ErrorClass::Transient;
    }

    ErrorClass::Fatal
}

/// Parse a `retry-after=<secs>` hint embedded by an adapter that controls its
/// own HTTP layer.
fn parse_retry_after(msg: &str) -> Option<Duration> {
    let idx = msg.find("retry-after=")?;
    let rest = &msg[idx + "retry-after=".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u64>().ok().map(Duration::from_secs)
}

/// Run `op`, retrying per [`RetryConfig`] and the classification of each error.
/// `op` is re-invoked for every attempt so it can rebuild its request.
pub async fn with_retry<'a>(
    config: &RetryConfig,
    classify: impl Fn(&anyhow::Error) -> ErrorClass,
    mut op: impl FnMut() -> ProviderFuture<'a>,
) -> anyhow::Result<ProviderResponse> {
    let mut rate_limit_attempt = 0u32;
    let mut transient_attempt = 0usize;

    loop {
        match op().await {
            Ok(resp) => return Ok(resp),
            Err(err) => match classify(&err) {
                ErrorClass::Fatal => return Err(err),
                ErrorClass::RateLimited { retry_after } => {
                    if rate_limit_attempt >= config.rate_limit_retries {
                        return Err(err);
                    }
                    rate_limit_attempt += 1;
                    let delay = retry_after.unwrap_or(config.rate_limit_delay);
                    sleep(delay).await;
                }
                ErrorClass::Transient => {
                    if transient_attempt >= config.transient_backoffs.len() {
                        return Err(err);
                    }
                    let delay = config.transient_backoffs[transient_attempt];
                    transient_attempt += 1;
                    sleep(delay).await;
                }
            },
        }
    }
}

async fn sleep(delay: Duration) {
    if delay.is_zero() {
        return;
    }
    tokio::time::sleep(delay).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn ok_response() -> ProviderResponse {
        ProviderResponse {
            text: "ok".into(),
            tool_calls: vec![],
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            cache_write: 0,
        }
    }

    fn fast_config() -> RetryConfig {
        RetryConfig {
            rate_limit_retries: 1,
            rate_limit_delay: Duration::ZERO,
            transient_backoffs: vec![Duration::ZERO, Duration::ZERO, Duration::ZERO],
        }
    }

    #[test]
    fn classifies_rate_limit_transient_and_fatal() {
        assert_eq!(
            classify_error(&anyhow::anyhow!("HTTP 429 Too Many Requests")),
            ErrorClass::RateLimited { retry_after: None }
        );
        assert_eq!(
            classify_error(&anyhow::anyhow!("cursor bridge returned 503: down")),
            ErrorClass::Transient
        );
        assert_eq!(
            classify_error(&anyhow::anyhow!("HTTP 401 unauthorized")),
            ErrorClass::Fatal
        );
    }

    #[test]
    fn parses_retry_after_hint() {
        assert_eq!(
            classify_error(&anyhow::anyhow!("429 rate limit; retry-after=7 seconds")),
            ErrorClass::RateLimited {
                retry_after: Some(Duration::from_secs(7))
            }
        );
    }

    #[tokio::test]
    async fn retries_transient_then_succeeds() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_c = calls.clone();
        let cfg = fast_config();
        let result = with_retry(&cfg, classify_error, move || {
            let calls = calls_c.clone();
            Box::pin(async move {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    anyhow::bail!("HTTP 503 service unavailable")
                }
                Ok(ok_response())
            })
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 3); // 2 failures + 1 success
    }

    #[tokio::test]
    async fn rate_limited_retries_once_then_gives_up() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_c = calls.clone();
        let cfg = fast_config();
        let result = with_retry(&cfg, classify_error, move || {
            let calls = calls_c.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("HTTP 429 too many requests")
            })
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2); // initial + 1 retry
    }

    #[tokio::test]
    async fn fatal_errors_do_not_retry() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_c = calls.clone();
        let cfg = fast_config();
        let result = with_retry(&cfg, classify_error, move || {
            let calls = calls_c.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("HTTP 400 bad request")
            })
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn transient_gives_up_after_schedule_exhausted() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_c = calls.clone();
        let cfg = fast_config(); // 3 transient backoffs
        let result = with_retry(&cfg, classify_error, move || {
            let calls = calls_c.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("network connection reset by peer")
            })
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 4); // initial + 3 retries
    }
}
