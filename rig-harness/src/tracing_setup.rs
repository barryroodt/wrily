use std::io::{self, IsTerminal, Write};

use tracing_subscriber::EnvFilter;

use crate::events::{ErrorKind, ExitCode, WrilyEvent};

pub fn init_tracing() {
    tracing_subscriber::fmt()
        .compact()
        .with_ansi(io::stderr().is_terminal())
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(io::stderr)
        .init();

    tracing::debug!(target: "wrily_rig", "stderr tracing initialized");
}

fn emit_event_safe(event: &WrilyEvent) {
    let _ = (|| -> io::Result<()> {
        let line = serde_json::to_string(event).map_err(|err| {
            io::Error::new(io::ErrorKind::InvalidData, err)
        })?;
        writeln!(io::stdout(), "{line}")?;
        io::stdout().flush()?;
        Ok(())
    })();
}

/// Emits terminal NDJSON for an unhandled panic. Used by the panic hook; exposed for tests.
pub fn emit_panic_events(message: String) {
    emit_event_safe(&WrilyEvent::Error {
        ts: 0,
        kind: ErrorKind::Internal,
        message,
    });
    emit_event_safe(&WrilyEvent::Result {
        ts: 0,
        exit: ExitCode::Error,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
        duration_ms: 0,
    });
}

pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        emit_panic_events(format!("{info}"));
        std::process::exit(1);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::WrilyEvent;

    #[test]
    fn panic_events_use_internal_error_and_error_exit() {
        let error = WrilyEvent::Error {
            ts: 0,
            kind: ErrorKind::Internal,
            message: "deliberate test panic".into(),
        };
        let result = WrilyEvent::Result {
            ts: 0,
            exit: ExitCode::Error,
            total_input: 0,
            total_output: 0,
            total_cache_read: 0,
            total_cache_write: 0,
            duration_ms: 0,
        };

        let error_json = serde_json::to_string(&error).expect("serialize error");
        let result_json = serde_json::to_string(&result).expect("serialize result");

        let error_value: serde_json::Value =
            serde_json::from_str(&error_json).expect("parse error json");
        assert_eq!(error_value["event"], "error");
        assert_eq!(error_value["kind"], "internal");

        let result_value: serde_json::Value =
            serde_json::from_str(&result_json).expect("parse result json");
        assert_eq!(result_value["event"], "result");
        assert_eq!(result_value["exit"], "error");
        assert_eq!(result_value["duration_ms"], 0);
    }
}
