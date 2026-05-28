use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;
use wrily_rig::cli::Cli;
use wrily_rig::events::{emit_event, ErrorKind, ExitCode, WrilyEvent};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();

    if let Err(err) = cli.validate() {
        emit_config_error(&err)?;
        std::process::exit(4);
    }

    let provider = match cli.resolve_provider() {
        Ok(provider) => provider,
        Err(err) => {
            emit_config_error(&err)?;
            std::process::exit(4);
        }
    };

    emit_event(&WrilyEvent::Start {
        ts: 0,
        model: cli.model.clone(),
        provider: provider.as_str().to_string(),
        mode: cli.mode.as_str().to_string(),
        workdir: cli.workdir.display().to_string(),
    })?;
    emit_event(&WrilyEvent::Result {
        ts: 0,
        exit: ExitCode::Ok,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
        duration_ms: 0,
    })?;

    Ok(())
}

fn emit_config_error(err: &wrily_rig::cli::ConfigError) -> Result<()> {
    emit_event(&WrilyEvent::Error {
        ts: 0,
        kind: ErrorKind::Config,
        message: err.to_string(),
    })?;
    emit_event(&WrilyEvent::Result {
        ts: 0,
        exit: ExitCode::Error,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
        duration_ms: 0,
    })?;
    Ok(())
}
