use anyhow::Result;
use serde::{Deserialize, Serialize};

pub const TRUNCATE_MARKER: &str = "…[truncated]";

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ExitCode {
    Ok,
    Budget,
    Timeout,
    Config,
    Error,
}

impl ExitCode {
    /// Map harness exit semantics to the process exit code consumed by the TS runner.
    pub fn as_process_exit(&self) -> i32 {
        match self {
            Self::Ok => 0,
            Self::Error => 1,
            Self::Budget => 2,
            Self::Timeout => 3,
            Self::Config => 4,
        }
    }
}

/// How a skill was resolved for [`WrilyEvent::SkillLoaded`].
///
/// `workdir` / `bundled` — auto-inject resolution (ADR-0002).
/// `auto` / `lazy` — legacy placeholders kept for roundtrip compat.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Auto,
    Lazy,
    Workdir,
    Bundled,
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

impl WrilyEvent {
    /// Terminal `result` event with zero counters. Real callers fill counters
    /// from TokenMeter once Phase 4 lands.
    pub fn terminal(exit: ExitCode) -> Self {
        Self::Result {
            ts: now_ms(),
            exit,
            total_input: 0,
            total_output: 0,
            total_cache_read: 0,
            total_cache_write: 0,
            duration_ms: 0,
        }
    }

    /// Emit as one NDJSON line on stdout + flush (via [`crate::emitter::EventEmitter`]).
    pub fn emit(&self) -> Result<()> {
        crate::emitter::emit_active(self)
    }
}

pub fn emit_event(event: &WrilyEvent) -> Result<()> {
    event.emit()
}
