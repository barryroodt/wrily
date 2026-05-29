use tempfile::TempDir;
use wrily_rig::events::TRUNCATE_MARKER;
use wrily_rig::tools::find_files::{find_files, FindFilesArgs};
use wrily_rig::tools::{ToolError, MAX_TOOL_OUTPUT_BYTES};

#[tokio::test]
async fn find_files_happy_path() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    std::fs::write(workdir.join("a.rs"), "").unwrap();
    std::fs::write(workdir.join("b.txt"), "").unwrap();
    std::fs::create_dir(workdir.join("nested")).unwrap();
    std::fs::write(workdir.join("nested/c.rs"), "").unwrap();

    let out = find_files(
        workdir,
        FindFilesArgs {
            pattern: "**/*.rs".into(),
            path: None,
        },
    )
    .await
    .unwrap();

    let entries: Vec<&str> = out.content.lines().collect();
    assert_eq!(entries, &["a.rs", "nested/c.rs"]);
    assert!(!out.truncated);
}

#[tokio::test]
async fn find_files_path_arg_scopes_root() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    std::fs::create_dir(workdir.join("nested")).unwrap();
    std::fs::write(workdir.join("nested/a.rs"), "").unwrap();
    std::fs::write(workdir.join("nested/b.txt"), "").unwrap();
    std::fs::write(workdir.join("root.rs"), "").unwrap();

    let out = find_files(
        workdir,
        FindFilesArgs {
            pattern: "*.rs".into(),
            path: Some("nested".into()),
        },
    )
    .await
    .unwrap();

    let entries: Vec<&str> = out.content.lines().collect();
    assert_eq!(entries, &["nested/a.rs"]);
    assert!(!out.truncated);
}

#[tokio::test]
async fn find_files_rejects_path_traversal() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = find_files(
        workdir,
        FindFilesArgs {
            pattern: "**/*".into(),
            path: Some("../etc".into()),
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn find_files_rejects_empty_pattern() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = find_files(
        workdir,
        FindFilesArgs {
            pattern: String::new(),
            path: None,
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::InvalidInput(_)));
}

#[tokio::test]
async fn find_files_rejects_invalid_glob() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = find_files(
        workdir,
        FindFilesArgs {
            pattern: "[".into(),
            path: None,
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::InvalidInput(_)));
}

#[tokio::test]
async fn find_files_truncates_large_output() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    for i in 0..10_000 {
        let name = format!("file_{i:06}_{}.rs", "x".repeat(40));
        std::fs::write(workdir.join(&name), "").unwrap();
    }

    let out = find_files(
        workdir,
        FindFilesArgs {
            pattern: "**/*.rs".into(),
            path: None,
        },
    )
    .await
    .unwrap();

    assert!(out.truncated);
    assert!(out.content.ends_with(TRUNCATE_MARKER));
    assert!(out.content.len() <= MAX_TOOL_OUTPUT_BYTES + TRUNCATE_MARKER.len());
    assert!(out.bytes > MAX_TOOL_OUTPUT_BYTES);
}
