use std::panic::AssertUnwindSafe;
use std::time::Instant;

use futures_util::FutureExt;
use wrily_rig::{
    cli::{Cli, Mode},
    events::{now_ms, ErrorKind, ExitCode, WrilyEvent},
    meter::MeterSnapshot,
    mode::{self, ModeRunOutcome},
    tracing_setup::{init_tracing, install_panic_hook},
};

fn empty_meter() -> MeterSnapshot {
    MeterSnapshot {
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
    }
}

fn emit_terminal_result(
    exit: ExitCode,
    meter: &MeterSnapshot,
    duration_ms: u64,
) -> anyhow::Result<()> {
    WrilyEvent::Result {
        ts: now_ms(),
        exit,
        total_input: meter.total_input,
        total_output: meter.total_output,
        total_cache_read: meter.total_cache_read,
        total_cache_write: meter.total_cache_write,
        duration_ms,
    }
    .emit()
}

fn finish(exit: ExitCode, meter: &MeterSnapshot, duration_ms: u64) -> ! {
    let _ = emit_terminal_result(exit, meter, duration_ms);
    std::process::exit(exit.as_process_exit());
}

/// Parse, validate, and run a mode. Returns the run outcome; the caller emits the
/// single terminal `result`. Config failures short-circuit to a `Config`
/// outcome (the `error{kind:"config"}` event is emitted here first).
async fn run_inner() -> ModeRunOutcome {
    if std::env::var("WRILY_RIG_PANIC_FOR_TEST").is_ok() {
        panic!("forced panic for test");
    }

    let v = match Cli::parse_and_validate() {
        Ok(v) => v,
        Err(err) => {
            let _ = WrilyEvent::Error {
                ts: now_ms(),
                kind: ErrorKind::Config,
                message: err.to_string(),
            }
            .emit();
            return ModeRunOutcome {
                exit: ExitCode::Config,
                meter: empty_meter(),
            };
        }
    };

    let _ = WrilyEvent::Start {
        ts: now_ms(),
        model: v.model.clone(),
        provider: v.provider.as_str().to_string(),
        mode: v.mode.as_str().to_string(),
        workdir: v.workdir.display().to_string(),
    }
    .emit();

    match v.mode {
        Mode::Single => mode::single::run_single(v).await,
        Mode::Team => mode::team::run_team(v).await,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    install_panic_hook();

    let started = Instant::now();

    // Catch a root panic so the process still emits exactly one terminal
    // `result` (exit "error", code 1) instead of aborting with no result line.
    // The panic hook has already emitted the `error{kind:"internal"}` event.
    let outcome = AssertUnwindSafe(run_inner()).catch_unwind().await;
    let elapsed = started.elapsed().as_millis() as u64;

    match outcome {
        Ok(outcome) => finish(outcome.exit, &outcome.meter, elapsed),
        Err(_panic) => finish(ExitCode::Error, &empty_meter(), elapsed),
    }
}
