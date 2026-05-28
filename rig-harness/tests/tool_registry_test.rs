use tempfile::TempDir;
use wrily_rig::emitter::TestEmitterGuard;
use wrily_rig::events::WrilyEvent;
use wrily_rig::tools::ToolRegistry;
use wrily_rig_evals::assertions::assert_tool_call_pairing;

const EXPECTED_TOOL_NAMES: [&str; 6] = [
    "read_file",
    "list_files",
    "find_files",
    "git_diff",
    "shell",
    "skill_load",
];

#[test]
fn schemas_returns_six_stable_tool_names() {
    let registry = ToolRegistry::new(std::env::temp_dir());
    let schemas = registry.schemas();

    assert_eq!(schemas.len(), 6);
    let names: Vec<&str> = schemas.iter().map(|schema| schema.name.as_str()).collect();
    assert_eq!(names, EXPECTED_TOOL_NAMES);
}

#[tokio::test]
async fn dispatch_read_file_happy_path() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hello world").unwrap();

    let registry = ToolRegistry::new(dir.path().to_path_buf());
    let out = registry
        .dispatch("assistant", 1, "read_file", r#"{"path":"hello.txt"}"#)
        .await;

    assert_eq!(out.content, "hello world");
    assert!(!out.truncated);
}

#[tokio::test]
async fn dispatch_unknown_tool_returns_error_content() {
    let registry = ToolRegistry::new(std::env::temp_dir());
    let out = registry
        .dispatch("assistant", 2, "unknown_tool", "{}")
        .await;

    assert!(
        out.content.starts_with("error: unknown tool:"),
        "unexpected content: {}",
        out.content
    );
}

#[tokio::test]
async fn dispatch_malformed_json_returns_invalid_input_error() {
    let registry = ToolRegistry::new(std::env::temp_dir());
    let out = registry.dispatch("assistant", 3, "read_file", "{").await;

    assert!(
        out.content.starts_with("error: invalid input:"),
        "unexpected content: {}",
        out.content
    );
}

#[tokio::test]
async fn dispatch_emits_paired_tool_call_and_tool_result_events() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("tracked.txt"), "tracked").unwrap();

    let guard = TestEmitterGuard::install();
    let registry = ToolRegistry::new(dir.path().to_path_buf());

    let _ = registry
        .dispatch("reviewer", 7, "read_file", r#"{"path":"tracked.txt"}"#)
        .await;

    let events = guard.drain_events();
    assert_eq!(
        events.len(),
        2,
        "expected one tool_call and one tool_result"
    );

    match (&events[0], &events[1]) {
        (
            WrilyEvent::ToolCall {
                role: call_role,
                turn: call_turn,
                tool: call_tool,
                args,
                ..
            },
            WrilyEvent::ToolResult {
                role: result_role,
                turn: result_turn,
                tool: result_tool,
                bytes,
                truncated,
                error,
                ..
            },
        ) => {
            assert_eq!(call_role, "reviewer");
            assert_eq!(result_role, "reviewer");
            assert_eq!(call_turn, &7);
            assert_eq!(result_turn, &7);
            assert_eq!(call_tool, "read_file");
            assert_eq!(result_tool, "read_file");
            assert_eq!(args, r#"{"path":"tracked.txt"}"#);
            assert_eq!(*bytes, 7);
            assert!(!truncated);
            assert!(error.is_none());
        }
        other => panic!("unexpected event sequence: {other:?}"),
    }

    assert_tool_call_pairing(&events).expect("tool_call/tool_result pairing");
}

#[tokio::test]
async fn dispatch_error_still_emits_paired_events_with_error_field() {
    let guard = TestEmitterGuard::install();
    let registry = ToolRegistry::new(std::env::temp_dir());

    let out = registry
        .dispatch("assistant", 4, "unknown_tool", "{}")
        .await;
    assert!(out.content.starts_with("error: unknown tool:"));

    let events = guard.drain_events();
    assert_eq!(events.len(), 2);

    let WrilyEvent::ToolResult { error, .. } = &events[1] else {
        panic!("expected tool_result second");
    };
    assert_eq!(
        error.as_deref(),
        Some(out.content.as_str()),
        "tool_result.error should mirror returned content"
    );

    assert_tool_call_pairing(&events).expect("pairing on error path");
}
