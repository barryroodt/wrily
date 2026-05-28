use std::process::Command;

use wrily_rig::events::{ExitCode, WrilyEvent};

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
        matches!(last, WrilyEvent::Result { exit: ExitCode::Config, .. }),
        "stdout must end with a config result event"
    );
}
