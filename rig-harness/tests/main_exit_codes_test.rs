use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};
use tempfile::TempDir;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};
use wrily_rig::events::{ExitCode, WrilyEvent};

struct EnvVarGuard {
    vars: Vec<(String, Option<String>)>,
}

impl EnvVarGuard {
    fn set_many(pairs: &[(&str, Option<&str>)]) -> Self {
        let mut vars = Vec::with_capacity(pairs.len());
        for (key, value) in pairs {
            let previous = std::env::var(key).ok();
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            vars.push(((*key).to_string(), previous));
        }
        Self { vars }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        for (key, previous) in self.vars.drain(..) {
            match previous {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

fn openai_base_url(mock_server: &MockServer) -> String {
    format!("{}/v1", mock_server.uri())
}

fn temp_fixture(name: &str) -> (TempDir, PathBuf, PathBuf) {
    let dir = TempDir::new().expect("temp dir");
    let workdir = dir.path().join("workdir");
    fs::create_dir_all(&workdir).expect("workdir");
    fs::write(workdir.join("sample.txt"), "sample content").expect("sample file");
    let prompt = dir.path().join(format!("{name}-prompt.txt"));
    fs::write(&prompt, "review this code").expect("prompt file");
    (dir, workdir, prompt)
}

fn base_args(workdir: &Path, prompt: &Path) -> Vec<String> {
    vec![
        "--mode".into(),
        "single".into(),
        "--model".into(),
        "gpt-4o".into(),
        "--workdir".into(),
        workdir.to_string_lossy().into_owned(),
        "--prompt-file".into(),
        prompt.to_string_lossy().into_owned(),
        "--max-tokens".into(),
        "8192".into(),
        "--timeout-ms".into(),
        "60000".into(),
    ]
}

fn run_bin(args: &[String], env: &[(&str, &str)]) -> (i32, String) {
    let bin = env!("CARGO_BIN_EXE_wrily-rig");
    let mut cmd = Command::new(bin);
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.args(args);
    let output = cmd.output().expect("run wrily-rig subprocess");
    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    (code, stdout)
}

fn terminal_result(stdout: &str) -> (WrilyEvent, Value) {
    let lines: Vec<&str> = stdout.lines().filter(|line| !line.is_empty()).collect();
    let last = lines.last().expect("stdout should contain NDJSON events");
    let value: Value = serde_json::from_str(last).expect("parse terminal NDJSON line");
    let event: WrilyEvent = serde_json::from_value(value.clone()).expect("parse terminal event");
    (event, value)
}

fn assert_exit(stdout: &str, code: i32, want: ExitCode) {
    let (event, value) = terminal_result(stdout);
    assert_eq!(
        code,
        want.as_process_exit(),
        "process exit code for {want:?}"
    );
    assert!(
        matches!(event, WrilyEvent::Result { exit, .. } if exit == want),
        "terminal result exit should be {want:?}, got {event:?}"
    );
    assert_eq!(
        value["exit"].as_str(),
        Some(exit_string(want)),
        "terminal result exit string"
    );
}

fn exit_string(exit: ExitCode) -> &'static str {
    match exit {
        ExitCode::Ok => "ok",
        ExitCode::Error => "error",
        ExitCode::Budget => "budget",
        ExitCode::Timeout => "timeout",
        ExitCode::Config => "config",
    }
}

fn ok_response() -> Value {
    json!({
        "id": "chatcmpl-ok",
        "object": "chat.completion",
        "created": 1_700_000_000,
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "review complete"
            },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 42,
            "completion_tokens": 17,
            "total_tokens": 59
        }
    })
}

fn budget_response() -> Value {
    json!({
        "id": "chatcmpl-budget",
        "object": "chat.completion",
        "created": 1_700_000_001,
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "too many tokens"
            },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2
        }
    })
}

fn timeout_response() -> Value {
    ok_response()
}

async fn mount_openai_mock(server: &MockServer, body: Value, delay: Option<Duration>) {
    let mut template = ResponseTemplate::new(200).set_body_json(body);
    if let Some(delay) = delay {
        template = template.set_delay(delay);
    }

    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer test-openai-key"))
        .respond_with(template)
        .mount(server)
        .await;
}

#[tokio::test]
async fn main_exit_ok_emits_terminal_result_with_token_totals() {
    let mock_server = MockServer::start().await;
    mount_openai_mock(&mock_server, ok_response(), None).await;

    let (_dir, workdir, prompt) = temp_fixture("ok");
    let args = base_args(&workdir, &prompt);

    let _env = EnvVarGuard::set_many(&[
        ("OPENAI_API_KEY", Some("test-openai-key")),
        (
            "OPENAI_BASE_URL",
            Some(openai_base_url(&mock_server).as_str()),
        ),
    ]);

    let (code, stdout) = run_bin(&args, &[]);
    assert_exit(&stdout, code, ExitCode::Ok);

    let (event, value) = terminal_result(&stdout);
    let WrilyEvent::Result {
        total_input,
        total_output,
        duration_ms,
        ..
    } = event
    else {
        panic!("expected terminal result event");
    };

    assert_eq!(total_input, 42, "terminal result should carry input total");
    assert_eq!(
        total_output, 17,
        "terminal result should carry output total"
    );
    assert!(
        duration_ms > 0,
        "terminal result should include duration_ms"
    );
    assert_eq!(value["total_input"], 42);
    assert_eq!(value["total_output"], 17);
    assert!(value["duration_ms"].as_u64().unwrap_or(0) > 0);
}

#[test]
fn main_exit_config_for_bad_model() {
    let (_dir, workdir, prompt) = temp_fixture("config");
    let mut args = base_args(&workdir, &prompt);
    for chunk in args.chunks_mut(2) {
        if chunk[0] == "--model" {
            chunk[1] = "llama-3".into();
        }
    }
    let (code, stdout) = run_bin(&args, &[]);
    assert_exit(&stdout, code, ExitCode::Config);

    let (event, _) = terminal_result(&stdout);
    let WrilyEvent::Result { duration_ms, .. } = event else {
        panic!("expected terminal result event");
    };
    assert!(
        duration_ms < 5_000,
        "config path should record a plausible duration_ms, got {duration_ms}"
    );
}

#[tokio::test]
async fn main_exit_budget_for_max_tokens_one() {
    let mock_server = MockServer::start().await;
    mount_openai_mock(&mock_server, budget_response(), None).await;

    let (_dir, workdir, prompt) = temp_fixture("budget");
    let mut args = base_args(&workdir, &prompt);
    for chunk in args.chunks_mut(2) {
        if chunk[0] == "--max-tokens" {
            chunk[1] = "1".into();
        }
    }

    let _env = EnvVarGuard::set_many(&[
        ("OPENAI_API_KEY", Some("test-openai-key")),
        (
            "OPENAI_BASE_URL",
            Some(openai_base_url(&mock_server).as_str()),
        ),
    ]);

    let (code, stdout) = run_bin(&args, &[]);
    assert_exit(&stdout, code, ExitCode::Budget);
}

#[tokio::test]
async fn main_exit_timeout_for_timeout_ms_one() {
    let mock_server = MockServer::start().await;
    mount_openai_mock(
        &mock_server,
        timeout_response(),
        Some(Duration::from_secs(5)),
    )
    .await;

    let (_dir, workdir, prompt) = temp_fixture("timeout");
    let mut args = base_args(&workdir, &prompt);
    for chunk in args.chunks_mut(2) {
        if chunk[0] == "--timeout-ms" {
            chunk[1] = "1".into();
        }
    }

    let _env = EnvVarGuard::set_many(&[
        ("OPENAI_API_KEY", Some("test-openai-key")),
        (
            "OPENAI_BASE_URL",
            Some(openai_base_url(&mock_server).as_str()),
        ),
    ]);

    let (code, stdout) = run_bin(&args, &[]);
    assert_exit(&stdout, code, ExitCode::Timeout);
}
