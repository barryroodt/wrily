use std::process::Command;

use wrily_rig::events::{ErrorKind, ExitCode, WrilyEvent};

#[test]
fn stderr_gets_tracing_stdout_stays_ndjson_only() {
    let bin = env!("CARGO_BIN_EXE_wrily-rig");
    let output = Command::new(bin)
        .args([
            "--mode",
            "single",
            "--model",
            "BAD-AMBIG",
            "--workdir",
            "/tmp",
            "--prompt-file",
            "/tmp/nope",
            "--max-tokens",
            "8192",
            "--timeout-ms",
            "60000",
        ])
        .env("RUST_LOG", "debug")
        .output()
        .expect("run wrily-rig subprocess");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("wrily_rig") && stderr.contains("stderr tracing initialized"),
        "expected debug tracing on stderr, got: {stderr}"
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().filter(|line| !line.is_empty()).collect();
    assert!(!lines.is_empty(), "stdout should contain NDJSON events");

    for line in &lines {
        serde_json::from_str::<serde_json::Value>(line)
            .unwrap_or_else(|err| panic!("stdout must be NDJSON-only, invalid line {line:?}: {err}"));
    }

    let last: WrilyEvent = serde_json::from_str(lines.last().expect("result line")).expect("parse");
    assert!(
        matches!(last, WrilyEvent::Result { exit: ExitCode::Error, .. }),
        "stdout must end with a result event"
    );
}

#[test]
fn panic_hook_emits_error_then_result_ndjson() {
    let error = WrilyEvent::Error {
        ts: 0,
        kind: ErrorKind::Internal,
        message: "deliberate test panic".into(),
    };
    let result = WrilyEvent::Result {
        ts: 0,
        exit: ExitCode::Error,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
        duration_ms: 0,
    };

    let error_json = serde_json::to_string(&error).expect("serialize error");
    let result_json = serde_json::to_string(&result).expect("serialize result");

    let parsed_error: WrilyEvent = serde_json::from_str(&error_json).expect("parse error");
    let parsed_result: WrilyEvent = serde_json::from_str(&result_json).expect("parse result");

    assert_eq!(parsed_error, error);
    assert_eq!(parsed_result, result);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&result_json)
            .expect("parse result value")["exit"],
        "error"
    );
}
