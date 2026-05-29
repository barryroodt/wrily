use tempfile::TempDir;
use wrily_rig::events::TRUNCATE_MARKER;
use wrily_rig::tools::list_files::{list_files, ListFilesArgs, MAX_DEPTH};
use wrily_rig::tools::{ToolError, MAX_TOOL_OUTPUT_BYTES};

#[tokio::test]
async fn list_files_happy_path() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    std::fs::write(workdir.join("a.txt"), "a").unwrap();
    std::fs::write(workdir.join("b.txt"), "b").unwrap();
    std::fs::write(workdir.join("c.txt"), "c").unwrap();
    std::fs::create_dir(workdir.join("sub")).unwrap();
    std::fs::write(workdir.join("sub/d.txt"), "d").unwrap();

    let out = list_files(
        workdir,
        ListFilesArgs {
            path: ".".into(),
            max_depth: Some(0),
        },
    )
    .await
    .unwrap();

    let entries: Vec<&str> = out.content.lines().collect();
    assert_eq!(entries.len(), 4);
    let mut sorted = entries.clone();
    sorted.sort();
    assert_eq!(entries, sorted);
    assert!(entries.iter().any(|e| e.ends_with("a.txt")));
    assert!(entries.iter().any(|e| e.ends_with("b.txt")));
    assert!(entries.iter().any(|e| e.ends_with("c.txt")));
    assert!(entries.iter().any(|e| e.ends_with("sub")));
    assert!(!out.content.contains("d.txt"));
    assert!(!out.truncated);
}

#[tokio::test]
async fn list_files_depth_cap_excludes_depth_six() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let mut path = workdir.to_path_buf();
    for i in 1..=6 {
        path = path.join(format!("l{i}"));
        std::fs::create_dir(&path).unwrap();
    }
    std::fs::write(path.join("deep.txt"), "deep").unwrap();

    let default_out = list_files(
        workdir,
        ListFilesArgs {
            path: ".".into(),
            max_depth: None,
        },
    )
    .await
    .unwrap();
    assert!(!default_out.content.contains("deep.txt"));

    let explicit_out = list_files(
        workdir,
        ListFilesArgs {
            path: ".".into(),
            max_depth: Some(MAX_DEPTH),
        },
    )
    .await
    .unwrap();
    assert!(!explicit_out.content.contains("deep.txt"));
    assert_eq!(default_out.content, explicit_out.content);
}

#[tokio::test]
async fn list_files_rejects_path_traversal() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = list_files(
        workdir,
        ListFilesArgs {
            path: "../".into(),
            max_depth: None,
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn list_files_skips_symlink_escape() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    let outside = TempDir::new().unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "secret").unwrap();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&secret, workdir.join("link.txt")).unwrap();
    }
    #[cfg(not(unix))]
    {
        return;
    }

    let out = list_files(
        workdir,
        ListFilesArgs {
            path: ".".into(),
            max_depth: None,
        },
    )
    .await
    .unwrap();

    assert!(!out.content.contains("link.txt"));
    assert!(!out.content.contains("secret"));
}

#[tokio::test]
async fn list_files_truncates_large_output() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    for i in 0..5000 {
        let name = format!("file_{i:06}_{}", "x".repeat(40));
        std::fs::write(workdir.join(&name), "x").unwrap();
    }

    let out = list_files(
        workdir,
        ListFilesArgs {
            path: ".".into(),
            max_depth: Some(0),
        },
    )
    .await
    .unwrap();

    assert!(out.truncated);
    assert!(out.content.ends_with(TRUNCATE_MARKER));
    assert!(out.content.len() <= MAX_TOOL_OUTPUT_BYTES + TRUNCATE_MARKER.len());
    assert!(out.bytes > MAX_TOOL_OUTPUT_BYTES);
}
