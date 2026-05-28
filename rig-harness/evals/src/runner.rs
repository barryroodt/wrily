use crate::{run_all, AssertionFailure, Expected};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use tokio::task::JoinSet;

pub struct FixtureRunner {
    pub binary_path: PathBuf,
    pub fixtures_dir: PathBuf,
    pub max_parallel: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FixtureResult {
    pub fixture: String,
    pub passed: bool,
    pub failures: Vec<AssertionFailure>,
    pub total_input: u64,
    pub total_output: u64,
    pub duration_ms: u64,
}

impl FixtureRunner {
    pub async fn run_all(&self) -> Result<Vec<FixtureResult>> {
        let entries: Vec<PathBuf> = std::fs::read_dir(&self.fixtures_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.path())
            .collect();

        let mut joinset = JoinSet::new();
        let binary = self.binary_path.clone();
        let max = self.max_parallel.max(1);

        let mut iter = entries.into_iter();
        let mut in_flight = 0usize;
        let mut results = Vec::new();

        loop {
            while in_flight < max {
                if let Some(dir) = iter.next() {
                    let binary = binary.clone();
                    joinset.spawn(async move { run_fixture(&binary, &dir).await });
                    in_flight += 1;
                } else {
                    break;
                }
            }
            if in_flight == 0 {
                break;
            }
            if let Some(res) = joinset.join_next().await {
                in_flight -= 1;
                results.push(res??);
            }
        }
        Ok(results)
    }
}

async fn run_fixture(binary: &Path, dir: &Path) -> Result<FixtureResult> {
    let name = dir.file_name().unwrap().to_string_lossy().to_string();
    let expected: Expected =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json"))?)?;
    let repo = dir.join("repo");
    let patch = dir.join("diff.patch");
    let prompt_file = dir.join("prompt.txt");

    // Apply patch (idempotent: assume tests run in isolated tmpcopy of repo).
    let tmpdir = tempfile::tempdir()?;
    copy_dir_recursive(&repo, tmpdir.path())?;
    if patch.exists() {
        Command::new("git")
            .arg("apply")
            .arg(&patch)
            .current_dir(tmpdir.path())
            .output()
            .await?;
    }

    let start = std::time::Instant::now();
    let out = Command::new(binary)
        .args([
            "--mode",
            "single",
            "--model",
            "claude-haiku-4-5-20251001",
            "--workdir",
            &tmpdir.path().display().to_string(),
            "--prompt-file",
            &prompt_file.display().to_string(),
            "--max-tokens",
            "200000",
            "--timeout-ms",
            "300000",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let events: Vec<wrily_rig::events::WrilyEvent> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    let failures = run_all(&events, &expected);
    let totals = events
        .iter()
        .rev()
        .find_map(|e| match e {
            wrily_rig::events::WrilyEvent::Result {
                total_input,
                total_output,
                ..
            } => Some((*total_input, *total_output)),
            _ => None,
        })
        .unwrap_or((0, 0));

    Ok(FixtureResult {
        fixture: name,
        passed: failures.is_empty(),
        failures,
        total_input: totals.0,
        total_output: totals.1,
        duration_ms,
    })
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dst_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&dst_path)?;
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}
