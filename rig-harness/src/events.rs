use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};

pub const TRUNCATE_MARKER: &str = "…[truncated]";

pub fn truncate_args(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut end = limit.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &s[..end], TRUNCATE_MARKER)
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Config,
    Provider,
    TeamCollapse,
    Internal,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ExitCode {
    Ok,
    Budget,
    Timeout,
    Error,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Auto,
    Lazy,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum WrilyEvent {
    Start {
        ts: u64,
        model: String,
        provider: String,
        mode: String,
        workdir: String,
    },
    SkillLoaded {
        ts: u64,
        name: String,
        source: SkillSource,
        bytes: u64,
    },
    AgentTurn {
        ts: u64,
        role: String,
        turn: u32,
        input_tokens: u64,
        output_tokens: u64,
        cache_read: u64,
        cache_write: u64,
    },
    ToolCall {
        ts: u64,
        role: String,
        turn: u32,
        tool: String,
        args: String,
    },
    ToolResult {
        ts: u64,
        role: String,
        turn: u32,
        tool: String,
        bytes: u64,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    SubagentSpawn {
        ts: u64,
        name: String,
        template: String,
        scope: String,
    },
    SubagentDone {
        ts: u64,
        name: String,
        turns: u32,
        input_tokens: u64,
        output_tokens: u64,
    },
    AssistantText {
        ts: u64,
        role: String,
        text: String,
    },
    BudgetExceeded {
        ts: u64,
        limit: u64,
        total: u64,
    },
    Error {
        ts: u64,
        kind: ErrorKind,
        message: String,
    },
    Result {
        ts: u64,
        exit: ExitCode,
        total_input: u64,
        total_output: u64,
        total_cache_read: u64,
        total_cache_write: u64,
        duration_ms: u64,
    },
}

pub fn emit_event(event: &WrilyEvent) -> Result<()> {
    let line = serde_json::to_string(event)?;
    println!("{line}");
    io::stdout().flush()?;
    Ok(())
}
