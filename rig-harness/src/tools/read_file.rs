use super::{resolve_workdir_path, truncate::truncated_output, ToolError, ToolOutput};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize, Serialize)]
pub struct ReadFileArgs {
    pub path: String,
}

/// Native read_file: workdir-rooted, 256 KiB truncation, traversal rejection.
pub async fn read_file(workdir: &Path, args: ReadFileArgs) -> Result<ToolOutput, ToolError> {
    let target = resolve_workdir_path(workdir, &args.path)?;
    let bytes = tokio::fs::read(&target).await?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(truncated_output(content))
}
