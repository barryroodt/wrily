mod cli;
mod events;
mod meter;
mod mode;
mod provider;
mod skills;
mod tools;

use anyhow::Result;
use events::{emit_event, ResultEvent, StartEvent};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let _cli = cli::parse();

    emit_event(&StartEvent::default())?;
    emit_event(&ResultEvent::ok())?;

    Ok(())
}
