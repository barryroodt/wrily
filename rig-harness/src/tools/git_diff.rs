use super::{resolve_workdir_path, truncate::truncated_output, ToolError, ToolOutput};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug, Deserialize, Serialize)]
pub struct GitDiffArgs {
    #[serde(default)]
    pub range: Option<String>, // e.g. "HEAD~3..HEAD" or "main..HEAD"
    #[serde(default)]
    pub paths: Vec<String>, // workdir-relative path filters
}

/// Strict regex for git refs/ranges. Allows alphanumerics, `_-./~` and `..`/`...`.
fn valid_range(s: &str) -> bool {
    use regex::Regex;
    static RE_INIT: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE_INIT
        .get_or_init(|| Regex::new(r"^[A-Za-z0-9_./~-]+(\.\.\.?[A-Za-z0-9_./~-]+)?$").unwrap());
    !s.is_empty() && s.len() <= 256 && re.is_match(s)
}

pub async fn git_diff(workdir: &Path, args: GitDiffArgs) -> Result<ToolOutput, ToolError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(workdir).arg("diff");
    if let Some(range) = args.range.as_deref() {
        if !valid_range(range) {
            return Err(ToolError::InvalidInput(format!("invalid range: {range}")));
        }
        cmd.arg(range);
    }
    if !args.paths.is_empty() {
        cmd.arg("--");
        for p in &args.paths {
            let _ = resolve_workdir_path(workdir, p)?; // traversal guard
            cmd.arg(p);
        }
    }
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(ToolError::InvalidInput(format!(
            "git diff failed: {stderr}"
        )));
    }
    let content = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(truncated_output(content))
}
