use tempfile::TempDir;
use wrily_rig::events::TRUNCATE_MARKER;
use wrily_rig::tools::shell::{shell, ShellArgs};
use wrily_rig::tools::{ToolError, MAX_TOOL_OUTPUT_BYTES};

#[tokio::test]
async fn shell_git_version_allowed() {
    let dir = TempDir::new().unwrap();
    let out = shell(
        dir.path(),
        ShellArgs {
            program: "git".into(),
            args: vec!["--version".into()],
        },
    )
    .await
    .unwrap();

    assert!(out.content.contains("git version"));
    assert!(!out.truncated);
}

#[tokio::test]
async fn shell_cat_absolute_path_rejected() {
    let dir = TempDir::new().unwrap();
    let err = shell(
        dir.path(),
        ShellArgs {
            program: "cat".into(),
            args: vec!["/etc/hosts".into()],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn shell_rejects_path_traversal_cat() {
    let dir = TempDir::new().unwrap();
    let err = shell(
        dir.path(),
        ShellArgs {
            program: "cat".into(),
            args: vec!["../../etc/passwd".into()],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn shell_rejects_parent_directory_ls() {
    let dir = TempDir::new().unwrap();
    let err = shell(
        dir.path(),
        ShellArgs {
            program: "ls".into(),
            args: vec!["..".into()],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn shell_rejects_absolute_path_ls() {
    let dir = TempDir::new().unwrap();
    let err = shell(
        dir.path(),
        ShellArgs {
            program: "ls".into(),
            args: vec!["/etc".into()],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn shell_git_no_pager_log_allowed() {
    let dir = TempDir::new().unwrap();
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(dir.path())
        .output()
        .unwrap();

    let out = shell(
        dir.path(),
        ShellArgs {
            program: "git".into(),
            args: vec!["--no-pager".into(), "log".into()],
        },
    )
    .await
    .unwrap();

    assert!(!out.truncated);
}

#[tokio::test]
async fn shell_rejects_disallowed_programs() {
    let dir = TempDir::new().unwrap();
    for program in ["rm", "sh", "bash", "python"] {
        let err = shell(
            dir.path(),
            ShellArgs {
                program: program.into(),
                args: vec![],
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(_)),
            "expected InvalidInput for {program}"
        );
    }
}

#[tokio::test]
async fn shell_rejects_unsafe_args() {
    let dir = TempDir::new().unwrap();
    let unsafe_args = [
        "; rm -rf /",
        "$(whoami)",
        "|",
        ">",
        "<",
        "`id`",
        "a\nb",
        "hello world",
    ];
    for arg in unsafe_args {
        let err = shell(
            dir.path(),
            ShellArgs {
                program: "git".into(),
                args: vec![arg.into()],
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidInput(_)),
            "expected InvalidInput for arg {arg:?}"
        );
    }
}

#[tokio::test]
async fn shell_rejects_empty_arg() {
    let dir = TempDir::new().unwrap();
    let err = shell(
        dir.path(),
        ShellArgs {
            program: "git".into(),
            args: vec![String::new()],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::InvalidInput(_)));
}

#[tokio::test]
async fn shell_rejects_long_arg() {
    let dir = TempDir::new().unwrap();
    let err = shell(
        dir.path(),
        ShellArgs {
            program: "git".into(),
            args: vec!["x".repeat(1025)],
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::InvalidInput(_)));
}

#[tokio::test]
async fn shell_find_truncates_large_output() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    for i in 0..10_000 {
        let name = format!("file_{i:06}_{}.txt", "x".repeat(40));
        std::fs::write(workdir.join(&name), "data\n").unwrap();
    }
    let out = shell(
        workdir,
        ShellArgs {
            program: "find".into(),
            args: vec![".".into(), "-type".into(), "f".into()],
        },
    )
    .await
    .unwrap();
    assert!(out.truncated);
    assert!(out.content.ends_with(TRUNCATE_MARKER));
    assert!(out.content.len() <= MAX_TOOL_OUTPUT_BYTES + TRUNCATE_MARKER.len());
    assert!(out.bytes > MAX_TOOL_OUTPUT_BYTES);
}
