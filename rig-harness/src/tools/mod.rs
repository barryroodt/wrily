pub mod find_files;
pub mod git_diff;
pub mod list_files;
pub mod read_file;
pub mod registry;
pub mod shell;
pub mod skill_load;
pub mod subagent;
pub mod truncate;

pub use registry::ToolRegistry;

use serde::{Deserialize, Serialize};

pub const MAX_TOOL_OUTPUT_BYTES: usize = 256 * 1024;

/// Common tool result shape returned by all native tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    pub content: String,
    pub bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("path outside workdir: {0}")]
    OutsideWorkdir(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("unknown tool: {0}")]
    UnknownTool(String),
}

/// Resolve a relative path against `workdir`, rejecting symlink-traversal escapes.
pub fn resolve_workdir_path(
    workdir: &std::path::Path,
    rel: &str,
) -> Result<std::path::PathBuf, ToolError> {
    let workdir = workdir.canonicalize().map_err(ToolError::Io)?;
    let joined = workdir.join(rel);
    let canonical = joined
        .canonicalize()
        .map_err(|_| ToolError::OutsideWorkdir(rel.to_string()))?;
    if !canonical.starts_with(&workdir) {
        return Err(ToolError::OutsideWorkdir(rel.to_string()));
    }
    Ok(canonical)
}
