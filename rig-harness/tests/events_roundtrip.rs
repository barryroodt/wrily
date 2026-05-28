use wrily_rig::events::{
    truncate_args, ErrorKind, ExitCode, SkillSource, WrilyEvent, TRUNCATE_MARKER,
};

fn roundtrip(event: &WrilyEvent) {
    let json = serde_json::to_string(event).expect("serialize");
    let back: WrilyEvent = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(*event, back);
}

#[test]
fn start_roundtrip() {
    roundtrip(&WrilyEvent::Start {
        ts: 1_700_000_000_000,
        model: "claude-sonnet".into(),
        provider: "anthropic".into(),
        mode: "single".into(),
        workdir: "/tmp/wrily".into(),
    });
}

#[test]
fn skill_loaded_roundtrip() {
    roundtrip(&WrilyEvent::SkillLoaded {
        ts: 1,
        name: "brainstorming".into(),
        source: SkillSource::Auto,
        bytes: 4096,
    });
}

#[test]
fn agent_turn_roundtrip() {
    roundtrip(&WrilyEvent::AgentTurn {
        ts: 2,
        role: "assistant".into(),
        turn: 1,
        input_tokens: 100,
        output_tokens: 50,
        cache_read: 10,
        cache_write: 5,
    });
}

#[test]
fn tool_call_roundtrip() {
    roundtrip(&WrilyEvent::ToolCall {
        ts: 3,
        role: "assistant".into(),
        turn: 2,
        tool: "read".into(),
        args: r#"{"path":"src/main.rs"}"#.into(),
    });
}

#[test]
fn tool_result_roundtrip() {
    roundtrip(&WrilyEvent::ToolResult {
        ts: 4,
        role: "assistant".into(),
        turn: 2,
        tool: "read".into(),
        bytes: 512,
        truncated: false,
        error: None,
    });
    roundtrip(&WrilyEvent::ToolResult {
        ts: 5,
        role: "assistant".into(),
        turn: 3,
        tool: "shell".into(),
        bytes: 0,
        truncated: false,
        error: Some("command failed".into()),
    });
}

#[test]
fn subagent_spawn_roundtrip() {
    roundtrip(&WrilyEvent::SubagentSpawn {
        ts: 6,
        name: "researcher".into(),
        template: "generalPurpose".into(),
        scope: "search docs".into(),
    });
}

#[test]
fn subagent_done_roundtrip() {
    roundtrip(&WrilyEvent::SubagentDone {
        ts: 7,
        name: "researcher".into(),
        turns: 3,
        input_tokens: 1000,
        output_tokens: 500,
    });
}

#[test]
fn assistant_text_roundtrip() {
    roundtrip(&WrilyEvent::AssistantText {
        ts: 8,
        role: "assistant".into(),
        text: "Hello, world.".into(),
    });
}

#[test]
fn budget_exceeded_roundtrip() {
    roundtrip(&WrilyEvent::BudgetExceeded {
        ts: 9,
        limit: 100_000,
        total: 100_001,
    });
}

#[test]
fn error_roundtrip() {
    roundtrip(&WrilyEvent::Error {
        ts: 10,
        kind: ErrorKind::Provider,
        message: "rate limited".into(),
    });
}

#[test]
fn result_roundtrip() {
    roundtrip(&WrilyEvent::Result {
        ts: 11,
        exit: ExitCode::Ok,
        total_input: 200,
        total_output: 100,
        total_cache_read: 20,
        total_cache_write: 10,
        duration_ms: 1500,
    });
}

#[test]
fn truncate_args_zero_limit_returns_marker() {
    assert_eq!(truncate_args("anything", 0), TRUNCATE_MARKER);
}

#[test]
fn truncate_args_ascii_within_limit() {
    assert_eq!(truncate_args("hello", 10), "hello");
}

#[test]
fn truncate_args_ascii_at_limit() {
    assert_eq!(truncate_args("hello", 5), "hello");
}

#[test]
fn truncate_args_ascii_over_limit() {
    assert_eq!(truncate_args("hello world", 5), format!("hello{TRUNCATE_MARKER}"));
}

#[test]
fn truncate_args_multibyte_char_boundary() {
    let s = "a😀b";
    assert_eq!(truncate_args(s, 2), format!("a{TRUNCATE_MARKER}"));
    assert_eq!(truncate_args(s, 3), format!("a{TRUNCATE_MARKER}"));
    assert_eq!(truncate_args(s, 4), format!("a{TRUNCATE_MARKER}"));
    assert_eq!(truncate_args(s, 5), format!("a😀{TRUNCATE_MARKER}"));
    assert_eq!(truncate_args(s, 6), "a😀b");
}
