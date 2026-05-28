use super::{resolve_workdir_path, truncate::truncated_output, ToolError, ToolOutput};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MAX_DEPTH: usize = 5;

#[derive(Debug, Deserialize, Serialize)]
pub struct ListFilesArgs {
    pub path: String, // relative to workdir
    #[serde(default)]
    pub max_depth: Option<usize>, // capped at MAX_DEPTH; default = MAX_DEPTH
}

/// Native list_files: depth-capped (≤5) recursive directory listing rooted at workdir/path.
/// Output is newline-separated paths relative to workdir, sorted lexicographically.
pub async fn list_files(workdir: &Path, args: ListFilesArgs) -> Result<ToolOutput, ToolError> {
    let workdir = workdir.canonicalize().map_err(ToolError::Io)?;
    let depth_cap = args.max_depth.unwrap_or(MAX_DEPTH).min(MAX_DEPTH);
    let root = resolve_workdir_path(&workdir, &args.path)?;
    if !root.is_dir() {
        return Err(ToolError::InvalidInput(format!("not a directory: {}", args.path)));
    }
    let mut entries = Vec::new();
    walk(&root, &workdir, depth_cap, 0, &mut entries)?;
    entries.sort();
    Ok(truncated_output(entries.join("\n")))
}

fn walk(
    dir: &Path,
    workdir: &Path,
    cap: usize,
    depth: usize,
    out: &mut Vec<String>,
) -> Result<(), ToolError> {
    if depth > cap {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        // Re-check traversal — symlinks could escape.
        if let Ok(canonical) = path.canonicalize() {
            if !canonical.starts_with(workdir) {
                continue;
            }
        }
        let rel = path
            .strip_prefix(workdir)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| path.display().to_string());
        out.push(rel);
        if path.is_dir() && depth < cap {
            walk(&path, workdir, cap, depth + 1, out)?;
        }
    }
    Ok(())
}
