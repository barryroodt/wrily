use std::io::Write;

use tempfile::TempDir;
use wrily_rig::events::TRUNCATE_MARKER;
use wrily_rig::tools::read_file::{read_file, ReadFileArgs};
use wrily_rig::tools::{ToolError, MAX_TOOL_OUTPUT_BYTES};

#[tokio::test]
async fn read_file_happy_path() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    let file_path = workdir.join("hello.txt");
    std::fs::write(&file_path, "hello world").unwrap();

    let out = read_file(
        workdir,
        ReadFileArgs {
            path: "hello.txt".into(),
        },
    )
    .await
    .unwrap();

    assert_eq!(out.content, "hello world");
    assert_eq!(out.bytes, 11);
    assert!(!out.truncated);
}

#[tokio::test]
async fn read_file_truncates_large_files() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    let file_path = workdir.join("big.bin");
    let payload = vec![b'a'; 300 * 1024];
    std::fs::write(&file_path, &payload).unwrap();

    let out = read_file(
        workdir,
        ReadFileArgs {
            path: "big.bin".into(),
        },
    )
    .await
    .unwrap();

    assert!(out.truncated);
    assert_eq!(out.bytes, 300 * 1024);
    assert!(out.content.ends_with(TRUNCATE_MARKER));
    assert!(out.content.len() <= MAX_TOOL_OUTPUT_BYTES + TRUNCATE_MARKER.len());
}

#[tokio::test]
async fn read_file_rejects_path_traversal() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = read_file(
        workdir,
        ReadFileArgs {
            path: "../etc/passwd".into(),
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn read_file_rejects_symlink_escape() {
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
        // Symlink tests are unix-specific; skip on other platforms.
        return;
    }

    let err = read_file(
        workdir,
        ReadFileArgs {
            path: "link.txt".into(),
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, ToolError::OutsideWorkdir(_)));
}

#[tokio::test]
async fn read_file_missing_file() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();

    let err = read_file(
        workdir,
        ReadFileArgs {
            path: "does-not-exist.txt".into(),
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(
        err,
        ToolError::OutsideWorkdir(_) | ToolError::Io(_)
    ));
}

#[tokio::test]
async fn read_file_truncates_on_utf8_boundary() {
    let dir = TempDir::new().unwrap();
    let workdir = dir.path();
    let file_path = workdir.join("utf8_edge.txt");

    // Fill to one byte before a 4-byte emoji so the cap splits mid-char.
    let mut content = String::new();
    content.push_str(&"a".repeat(MAX_TOOL_OUTPUT_BYTES - 3));
    content.push('😀');
    content.push_str("tail");

    let mut file = std::fs::File::create(&file_path).unwrap();
    file.write_all(content.as_bytes()).unwrap();

    let out = read_file(
        workdir,
        ReadFileArgs {
            path: "utf8_edge.txt".into(),
        },
    )
    .await
    .unwrap();

    assert!(out.truncated);
    assert_eq!(out.bytes, content.len());
    assert!(out.content.ends_with(TRUNCATE_MARKER));
    // Truncated prefix must be valid UTF-8.
    assert!(std::str::from_utf8(out.content.as_bytes()).is_ok());
    // The emoji should not appear partially — cut before it.
    assert!(!out.content.contains('😀'));
}
