use std::io::{self, IsTerminal};

use tracing_subscriber::EnvFilter;

use crate::events::{ErrorKind, ExitCode, WrilyEvent, now_ms};

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

pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        eprintln!("{info}");
        let _ = WrilyEvent::Error {
            ts: now_ms(),
            kind: ErrorKind::Internal,
            message: format!("{info}"),
        }
        .emit();
        let _ = WrilyEvent::terminal(ExitCode::Error).emit();
        std::process::exit(1);
    }));
}
