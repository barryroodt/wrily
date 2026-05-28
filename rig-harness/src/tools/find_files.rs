use super::{resolve_workdir_path, truncate::truncated_output, ToolError, ToolOutput};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize, Serialize)]
pub struct FindFilesArgs {
    pub pattern: String, // glob pattern, e.g. "**/*.rs"
    #[serde(default)]
    pub path: Option<String>, // root relative to workdir; default = "."
}

/// Native find_files: globwalk-rooted recursive glob. Output is newline-separated
/// paths relative to workdir, sorted lexicographically.
pub async fn find_files(workdir: &Path, args: FindFilesArgs) -> Result<ToolOutput, ToolError> {
    let workdir = workdir.canonicalize().map_err(ToolError::Io)?;
    let root_rel = args.path.as_deref().unwrap_or(".");
    let root = resolve_workdir_path(&workdir, root_rel)?;
    if !root.is_dir() {
        return Err(ToolError::InvalidInput(format!(
            "not a directory: {root_rel}"
        )));
    }
    if args.pattern.is_empty() {
        return Err(ToolError::InvalidInput("empty pattern".into()));
    }

    let walker = globwalk::GlobWalkerBuilder::from_patterns(&root, &[&args.pattern])
        .follow_links(false)
        .build()
        .map_err(|e| ToolError::InvalidInput(format!("invalid glob: {e}")))?;

    let mut entries = Vec::new();
    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        // Symlink-traversal guard.
        if let Ok(canonical) = path.canonicalize() {
            if !canonical.starts_with(&workdir) {
                continue;
            }
        }
        let rel = path
            .strip_prefix(&workdir)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| path.display().to_string());
        entries.push(rel);
    }
    entries.sort();
    Ok(truncated_output(entries.join("\n")))
}
