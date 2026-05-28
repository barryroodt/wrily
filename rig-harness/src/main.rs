use wrily_rig::{
    cli::Cli,
    events::{now_ms, ErrorKind, ExitCode, WrilyEvent},
    tracing_setup::{init_tracing, install_panic_hook},
};

fn main() -> anyhow::Result<()> {
    init_tracing();
    install_panic_hook();

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
            WrilyEvent::terminal(ExitCode::Config).emit()?;
            std::process::exit(4);
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

    WrilyEvent::terminal(ExitCode::Ok).emit()?;
    Ok(())
}
