use std::sync::Arc;
use std::time::Duration;

use wrily_rig::cancel;
use wrily_rig::meter::TokenMeter;

#[tokio::test]
async fn spawn_timeout_watchdog_cancels_after_delay() {
    let token = cancel::shared_token();
    let _handle = cancel::spawn_timeout_watchdog(token.clone(), 50);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(token.is_cancelled());
}

#[tokio::test]
async fn watchdog_exits_when_token_already_cancelled() {
    let token = cancel::shared_token();
    let handle = cancel::spawn_timeout_watchdog(token.clone(), 1000);
    token.cancel();
    tokio::time::timeout(Duration::from_millis(100), handle)
        .await
        .expect("watchdog should complete when token is cancelled early")
        .expect("watchdog join");
    assert!(token.is_cancelled());
}

#[tokio::test]
async fn token_meter_trip_propagates_to_waiters_within_10ms() {
    let token = cancel::shared_token();
    let meter = Arc::new(TokenMeter::new(10, token.clone()));

    let mut handles = Vec::new();
    for _ in 0..5 {
        let t = token.clone();
        handles.push(tokio::spawn(async move {
            t.cancelled().await;
        }));
    }

    tokio::task::yield_now().await;

    let _ = meter.add(11, 0, 0, 0);
    assert!(token.is_cancelled());

    let max = Duration::from_millis(10);
    for handle in handles {
        tokio::time::timeout(max, handle)
            .await
            .expect("waiter should observe cancellation within 10ms")
            .expect("waiter join");
    }
}
