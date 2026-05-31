use std::io::{self, IsTerminal};

use tracing_subscriber::EnvFilter;

use crate::events::{now_ms, ErrorKind, WrilyEvent};

pub fn init_tracing() {
    tracing_subscriber::fmt()
        .compact()
        .with_ansi(io::stderr().is_terminal())
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(io::stderr)
        .try_init()
        .ok();

    tracing::debug!(target: "wrily_rig", "stderr tracing initialized");
}

/// Install a panic hook that emits an `error{kind:"internal"}` NDJSON event (and
/// a stderr backtrace) for any panic, but does **not** exit the process.
///
/// Exiting here would kill the whole run on a *contained* panic — e.g. a single
/// reviewer subagent caught by `catch_unwind` for N-1 degradation. Instead the
/// root (`main`) catches its own panic via `catch_unwind` and emits the single
/// terminal `result` event, preserving the "exactly one result" invariant.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        eprintln!("{info}");
        let _ = WrilyEvent::Error {
            ts: now_ms(),
            kind: ErrorKind::Internal,
            message: format!("{info}"),
        }
        .emit();
    }));
}
