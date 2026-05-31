use std::fs;
use std::path::PathBuf;
use std::process::Command;

use tempfile::TempDir;
use wrily_rig_evals::{Expected, FixtureRunner};

fn write_minimal_fixture(root: &std::path::Path) {
    fs::create_dir_all(root.join("repo")).expect("repo dir");
    fs::write(root.join("diff.patch"), "").expect("empty patch");
    fs::write(root.join("prompt.txt"), "Say hello.\n").expect("prompt");
    let expected = Expected {
        fixture: "minimal".into(),
        exit: "ok".into(),
        max_tokens: None,
        min_findings: None,
        max_findings: None,
        must_contain_severity: Vec::new(),
        must_match_path: Vec::new(),
        must_match_message_regex: Vec::new(),
        forbid_match_message_regex: Vec::new(),
        require_single_json_fence: Some(false),
        max_input_tokens: None,
        max_output_tokens: None,
        max_duration_ms: None,
    };
    fs::write(
        root.join("expected.json"),
        serde_json::to_string_pretty(&expected).expect("serialize expected"),
    )
    .expect("expected.json");
}

fn wrily_rig_binary() -> Option<PathBuf> {
    std::env::var("CARGO_BIN_EXE_wrily-rig")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

#[tokio::test]
async fn fixture_runner_happy_path() {
    let Some(binary) = wrily_rig_binary() else {
        eprintln!("skipping fixture_runner_happy_path: wrily-rig binary not found");
        return;
    };

    if std::env::var("ANTHROPIC_API_KEY").is_err() {
        eprintln!("skipping fixture_runner_happy_path: ANTHROPIC_API_KEY not set");
        return;
    }

    let fixtures_root = TempDir::new().expect("fixtures temp dir");
    let fixture_dir = fixtures_root.path().join("minimal");
    fs::create_dir_all(&fixture_dir).expect("fixture dir");
    write_minimal_fixture(&fixture_dir);

    let runner = FixtureRunner {
        binary_path: binary,
        fixtures_dir: fixtures_root.path().to_path_buf(),
        max_parallel: 1,
    };

    let results = runner.run_all().await.expect("run fixtures");
    assert_eq!(results.len(), 1, "expected one fixture result");

    let result = &results[0];
    assert_eq!(result.fixture, "minimal");
    assert!(
        result.passed,
        "fixture should pass assertions: {:?}",
        result.failures
    );
}

#[test]
fn fixture_runner_binary_is_available() {
    let Some(binary) = wrily_rig_binary() else {
        eprintln!("skipping fixture_runner_binary_is_available: CARGO_BIN_EXE_wrily-rig not set");
        return;
    };
    assert!(binary.exists(), "wrily-rig binary should exist");
}

#[test]
fn minimal_fixture_layout_is_valid() {
    let dir = TempDir::new().expect("temp dir");
    write_minimal_fixture(dir.path());

    assert!(dir.path().join("repo").is_dir());
    assert!(dir.path().join("diff.patch").exists());
    assert!(dir.path().join("prompt.txt").is_file());
    let expected: Expected =
        serde_json::from_str(&fs::read_to_string(dir.path().join("expected.json")).unwrap())
            .unwrap();
    assert_eq!(expected.exit, "ok");

    Command::new("git")
        .args(["init"])
        .current_dir(dir.path().join("repo"))
        .output()
        .expect("git init in repo");
}
