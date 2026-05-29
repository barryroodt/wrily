use crate::events::{now_ms, WrilyEvent};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio_util::sync::CancellationToken;

pub struct TokenMeter {
    limit: u64,
    total_input: AtomicU64,
    total_output: AtomicU64,
    total_cache_read: AtomicU64,
    total_cache_write: AtomicU64,
    tripped: AtomicBool,
    cancel: CancellationToken,
}

pub struct MeterSnapshot {
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_write: u64,
}

impl TokenMeter {
    pub fn new(limit: u64, cancel: CancellationToken) -> Self {
        Self {
            limit,
            total_input: AtomicU64::new(0),
            total_output: AtomicU64::new(0),
            total_cache_read: AtomicU64::new(0),
            total_cache_write: AtomicU64::new(0),
            tripped: AtomicBool::new(false),
            cancel,
        }
    }

    /// Add token counts from a provider response. Returns Ok(()) if under budget,
    /// or `Err(BudgetExceeded)` if this addition crossed the cap. The error includes
    /// the total after addition. Emits `budget_exceeded` NDJSON exactly once across all
    /// concurrent callers (via tripped flag CAS).
    pub fn add(
        &self,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
    ) -> Result<(), BudgetExceeded> {
        self.total_input.fetch_add(input, Ordering::SeqCst);
        self.total_output.fetch_add(output, Ordering::SeqCst);
        self.total_cache_read
            .fetch_add(cache_read, Ordering::SeqCst);
        self.total_cache_write
            .fetch_add(cache_write, Ordering::SeqCst);
        let total =
            self.total_input.load(Ordering::SeqCst) + self.total_output.load(Ordering::SeqCst);
        if total >= self.limit {
            // CAS so only the first crossing emits.
            if self
                .tripped
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let _ = WrilyEvent::BudgetExceeded {
                    ts: now_ms(),
                    limit: self.limit,
                    total,
                }
                .emit();
                self.cancel.cancel();
            }
            return Err(BudgetExceeded {
                limit: self.limit,
                total,
            });
        }
        Ok(())
    }

    pub fn snapshot(&self) -> MeterSnapshot {
        MeterSnapshot {
            total_input: self.total_input.load(Ordering::SeqCst),
            total_output: self.total_output.load(Ordering::SeqCst),
            total_cache_read: self.total_cache_read.load(Ordering::SeqCst),
            total_cache_write: self.total_cache_write.load(Ordering::SeqCst),
        }
    }

    pub fn tripped(&self) -> bool {
        self.tripped.load(Ordering::SeqCst)
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }
}

#[derive(Debug, thiserror::Error)]
#[error("budget exceeded: total={total} limit={limit}")]
pub struct BudgetExceeded {
    pub total: u64,
    pub limit: u64,
}
