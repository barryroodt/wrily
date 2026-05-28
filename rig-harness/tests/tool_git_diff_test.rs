use std::path::Path;

use tempfile::TempDir;
use tokio::process::Command;
use wrily_rig::tools::git_diff::{git_diff, GitDiffArgs};
use wrily_rig::tools::ToolError;

async fn git(workdir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(workdir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "test")
        .env("GIT_AUTHOR_EMAIL", "test@test.com")
        .env("GIT_COMMITTER_NAME", "test")
        .env("GIT_COMMITTER_EMAIL", "test@test.com")
        .status()
        .await
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

async fn setup_repo(workdir: &Path) {
    git(workdir, &["init"]).await;
    git(workdir, &["config", "user.email", "test@test.com"]).await;
    git(workdir, &["config", "user.name", "test"]).await;
}

#[tokio::test]
async fn git_diff_working_tree_changes() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    setup_repo(workdir).await;

    std::fs::write(workdir.join("file.txt"), "v1\n").unwrap();
    git(workdir, &["add", "file.txt"]).await;
    git(workdir, &["commit", "-m", "initial"]).await;

    std::fs::write(workdir.join("file.txt"), "v2\n").unwrap();

    let out = git_diff(
        workdir,
        GitDiffArgs {
            range: None,
            paths: vec![],
        },
    )
    .await
    .unwrap();

    assert!(out.content.contains("-v1"));
    assert!(out.content.contains("+v2"));
    assert!(!out.truncated);
}

#[tokio::test]
async fn git_diff_range_between_commits() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    setup_repo(workdir).await;

    std::fs::write(workdir.join("file.txt"), "v1\n").unwrap();
    git(workdir, &["add", "."]).await;
    git(workdir, &["commit", "-m", "first"]).await;

    std::fs::write(workdir.join("file.txt"), "v2\n").unwrap();
    git(workdir, &["add", "."]).await;
    git(workdir, &["commit", "-m", "second"]).await;

    let out = git_diff(
        workdir,
        GitDiffArgs {
            range: Some("HEAD~1..HEAD".into()),
            paths: vec![],
        },
    )
    .await
    .unwrap();

    assert!(out.content.contains("-v1"));
    assert!(out.content.contains("+v2"));
}

#[tokio::test]
async fn git_diff_rejects_invalid_range() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    setup_repo(workdir).await;

    let err = git_diff(
        workdir,
        GitDiffArgs {
            range: Some("; rm -rf /".into()),
            paths: vec![],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::InvalidInput(_)));
}

#[tokio::test]
async fn git_diff_rejects_path_traversal() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    setup_repo(workdir).await;

    let err = git_diff(
        workdir,
        GitDiffArgs {
            range: None,
            paths: vec!["../etc".into()],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn git_diff_empty_when_no_changes() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    setup_repo(workdir).await;

    std::fs::write(workdir.join("file.txt"), "v1\n").unwrap();
    git(workdir, &["add", "."]).await;
    git(workdir, &["commit", "-m", "initial"]).await;

    let out = git_diff(
        workdir,
        GitDiffArgs {
            range: None,
            paths: vec![],
        },
    )
    .await
    .unwrap();

    assert_eq!(out.content, "");
    assert_eq!(out.bytes, 0);
    assert!(!out.truncated);
}
