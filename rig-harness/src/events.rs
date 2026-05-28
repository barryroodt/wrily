use anyhow::Result;
use serde::Serialize;
use std::io::{self, Write};

#[derive(Serialize)]
pub struct StartEvent {
    pub event: &'static str,
}

impl Default for StartEvent {
    fn default() -> Self {
        Self { event: "start" }
    }
}

#[derive(Serialize)]
pub struct ResultEvent {
    pub event: &'static str,
    pub exit: String,
}

impl ResultEvent {
    pub fn ok() -> Self {
        Self {
            event: "result",
            exit: "ok".into(),
        }
    }
}

pub fn emit_event<T: Serialize>(event: &T) -> Result<()> {
    let line = serde_json::to_string(event)?;
    println!("{line}");
    io::stdout().flush()?;
    Ok(())
}
