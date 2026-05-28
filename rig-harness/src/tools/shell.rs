use super::{truncate::truncated_output, ToolError, ToolOutput};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

pub const ALLOWED_PROGRAMS: &[&str] = &["git", "cat", "ls", "find"];

#[derive(Debug, Deserialize, Serialize)]
pub struct ShellArgs {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Reject characters that shells interpret (per-arg).
/// Allowed: alnum, dash, underscore, dot, slash, equals, colon, comma, plus, at.
fn safe_arg(a: &str) -> bool {
    !a.is_empty()
        && a.len() <= 1024
        && a.chars().all(|c| c.is_alphanumeric() || "-_./=:,+@".contains(c))
}

pub async fn shell(workdir: &Path, args: ShellArgs) -> Result<ToolOutput, ToolError> {
    if !ALLOWED_PROGRAMS.contains(&args.program.as_str()) {
        return Err(ToolError::InvalidInput(format!(
            "program not allowlisted: {}",
            args.program
        )));
    }
    for a in &args.args {
        if !safe_arg(a) {
            return Err(ToolError::InvalidInput(format!("unsafe arg: {a}")));
        }
    }
    let out = Command::new(&args.program)
        .args(&args.args)
        .current_dir(workdir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    let mut content = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        content.push_str("\n[stderr]\n");
        content.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Ok(truncated_output(content))
}
