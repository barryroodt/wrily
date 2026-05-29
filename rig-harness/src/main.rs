use std::time::Instant;

use wrily_rig::{
    cli::{Cli, Mode},
    events::{now_ms, ErrorKind, ExitCode, WrilyEvent},
    meter::MeterSnapshot,
    mode,
    tracing_setup::{init_tracing, install_panic_hook},
};

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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    install_panic_hook();

    let started = Instant::now();
    let empty_meter = MeterSnapshot {
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
    };

    if std::env::var("WRILY_RIG_PANIC_FOR_TEST").is_ok() {
        panic!("forced panic for test");
    }

    let v = match Cli::parse_and_validate() {
        Ok(v) => v,
        Err(err) => {
            WrilyEvent::Error {
                ts: now_ms(),
                kind: ErrorKind::Config,
                message: err.to_string(),
            }
            .emit()?;
            finish(
                ExitCode::Config,
                &empty_meter,
                started.elapsed().as_millis() as u64,
            );
        }
    };

    WrilyEvent::Start {
        ts: now_ms(),
        model: v.model.clone(),
        provider: format!("{:?}", v.provider).to_lowercase(),
        mode: format!("{:?}", v.mode).to_lowercase(),
        workdir: v.workdir.display().to_string(),
    }
    .emit()?;

    let outcome = match v.mode {
        Mode::Single => mode::single::run_single(v).await,
        Mode::Team => mode::team::run_team(v).await,
    };

    finish(
        outcome.exit,
        &outcome.meter,
        started.elapsed().as_millis() as u64,
    );
}
