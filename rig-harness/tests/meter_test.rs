use std::sync::Arc;
use std::thread;

use tokio_util::sync::CancellationToken;
use wrily_rig::emitter::TestEmitterGuard;
use wrily_rig::events::WrilyEvent;
use wrily_rig::meter::{BudgetExceeded, TokenMeter};

#[test]
fn add_under_limit_ok_no_event() {
    let guard = TestEmitterGuard::install();
    let cancel = CancellationToken::new();
    let meter = TokenMeter::new(100, cancel.clone());

    assert!(meter.add(30, 20, 5, 5).is_ok());
    assert!(guard.drain_events().is_empty());
    assert!(!cancel.is_cancelled());
    assert!(!meter.tripped());
}

#[test]
fn add_crossing_limit_emits_once_and_cancels() {
    let guard = TestEmitterGuard::install();
    let cancel = CancellationToken::new();
    let meter = TokenMeter::new(100, cancel.clone());

    let err = meter.add(60, 50, 0, 0).unwrap_err();
    assert_eq!(err.limit, 100);
    assert_eq!(err.total, 110);

    let events = guard.drain_events();
    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0],
        WrilyEvent::BudgetExceeded {
            limit: 100,
            total: 110,
            ..
        }
    ));
    assert!(cancel.is_cancelled());
    assert!(meter.tripped());
}

#[test]
fn post_trip_add_returns_err_without_second_event() {
    let guard = TestEmitterGuard::install();
    let cancel = CancellationToken::new();
    let meter = TokenMeter::new(50, cancel.clone());

    assert!(matches!(
        meter.add(30, 30, 0, 0),
        Err(BudgetExceeded { limit: 50, total: 60 })
    ));
    assert!(matches!(
        meter.add(1, 0, 0, 0),
        Err(BudgetExceeded { .. })
    ));

    let events = guard.drain_events();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], WrilyEvent::BudgetExceeded { .. }));
    assert!(cancel.is_cancelled());
}

#[test]
fn concurrent_trip_emits_budget_exceeded_exactly_once() {
    let cancel = CancellationToken::new();
    let meter = Arc::new(TokenMeter::new(1000, cancel.clone()));

    let handles: Vec<_> = (0..100)
        .map(|_| {
            let meter = Arc::clone(&meter);
            thread::spawn(move || {
                let guard = TestEmitterGuard::install();
                let result = meter.add(10, 10, 0, 0);
                let events = guard.drain_events();
                (result, events)
            })
        })
        .collect();

    let mut budget_exceeded_events = 0usize;
    let mut err_count = 0usize;
    let mut ok_count = 0usize;

    for handle in handles {
        let (result, events) = handle.join().expect("thread join");
        budget_exceeded_events += events
            .iter()
            .filter(|event| matches!(event, WrilyEvent::BudgetExceeded { .. }))
            .count();
        if result.is_err() {
            err_count += 1;
        } else {
            ok_count += 1;
        }
    }

    assert_eq!(budget_exceeded_events, 1, "budget_exceeded must emit exactly once");
    assert!(cancel.is_cancelled());
    assert!(meter.tripped());
    assert!(err_count > 0, "at least one caller must see BudgetExceeded");
    assert!(ok_count > 0, "callers finishing before the cap must still succeed");
    assert_eq!(err_count + ok_count, 100);
}

#[test]
fn snapshot_reflects_accumulated_totals() {
    let meter = TokenMeter::new(10_000, CancellationToken::new());

    meter.add(10, 20, 1, 2).unwrap();
    meter.add(5, 15, 3, 4).unwrap();

    let snap = meter.snapshot();
    assert_eq!(snap.total_input, 15);
    assert_eq!(snap.total_output, 35);
    assert_eq!(snap.total_cache_read, 4);
    assert_eq!(snap.total_cache_write, 6);
}
